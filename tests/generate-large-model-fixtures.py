#!/usr/bin/env python3
"""Stream real, referenced terrain geometry; no holes or padding as model payload.

The repeated tiles are intentional: this tests source throughput, decoded geometry
budgets and progressive preparation reproducibly, not high-entropy worst cases.
Every vertex byte is used by a distinct mesh. Tiles have distinct materials and
node transforms, and all four embedded PNG textures are referenced.
"""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import resource
import shutil
import struct
import subprocess
import sys
import time
import zlib

REPO = Path(__file__).resolve().parents[1]
VERTEX = struct.Struct('<8f')


def png(index):
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))
    rows = bytearray()
    for y in range(16):
        rows.append(0)
        for x in range(16):
            shade = 235 if (x // 4 + y // 4) % 2 else 100
            rows.extend((shade, max(0, shade - index * 15), max(0, shade - index * 30), 255))
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>2I5B', 16, 16, 8, 6, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(rows)) + chunk(b'IEND', b'')


def row_vertices(grid, row):
    result = []
    y = row / grid
    for column in range(grid + 1):
        x = column / grid
        z = .1 * math.sin(math.tau * x) * math.cos(math.tau * y)
        dx = .1 * math.tau * math.cos(math.tau * x) * math.cos(math.tau * y)
        dy = -.1 * math.tau * math.sin(math.tau * x) * math.sin(math.tau * y)
        length = math.sqrt(dx * dx + dy * dy + 1)
        result.append(VERTEX.pack(x, y, z, -dx / length, -dy / length, 1 / length, x, y))
    return result


def write_model(path, grid, tiles):
    triangles = tiles * grid * grid * 2
    vertex_count = grid * grid * 6
    tile_bytes = vertex_count * VERTEX.size
    geometry_bytes = tile_bytes * tiles
    views, accessors, materials, meshes, nodes = [], [], [], [], []
    columns = math.ceil(math.sqrt(tiles))
    amplitude = struct.unpack('<f', struct.pack('<f', .1))[0]
    for tile in range(tiles):
        views.append({'buffer': 0, 'byteOffset': tile * tile_bytes, 'byteLength': tile_bytes, 'byteStride': 32, 'target': 34962})
        accessors.extend([
            {'bufferView': tile, 'byteOffset': 0, 'componentType': 5126, 'count': vertex_count, 'type': 'VEC3', 'min': [0, 0, -amplitude], 'max': [1, 1, amplitude]},
            {'bufferView': tile, 'byteOffset': 12, 'componentType': 5126, 'count': vertex_count, 'type': 'VEC3'},
            {'bufferView': tile, 'byteOffset': 24, 'componentType': 5126, 'count': vertex_count, 'type': 'VEC2'},
        ])
        materials.append({'name': f'Tile material {tile}', 'doubleSided': True, 'pbrMetallicRoughness': {'baseColorFactor': [.35 + .6 * tile / max(1, tiles - 1), .5, .8, 1], 'metallicFactor': 0, 'roughnessFactor': .85, 'baseColorTexture': {'index': tile % 4}}})
        meshes.append({'name': f'Terrain tile {tile}', 'primitives': [{'attributes': {'POSITION': tile * 3, 'NORMAL': tile * 3 + 1, 'TEXCOORD_0': tile * 3 + 2}, 'material': tile, 'mode': 4}]})
        nodes.append({'name': f'Tile {tile}', 'mesh': tile, 'translation': [tile % columns * 1.02, tile // columns * 1.02, 0]})
    textures = [png(index) for index in range(4)]
    offset = geometry_bytes
    images = []
    for index, texture in enumerate(textures):
        views.append({'buffer': 0, 'byteOffset': offset, 'byteLength': len(texture)})
        images.append({'bufferView': tiles + index, 'mimeType': 'image/png'})
        offset += (len(texture) + 3) & ~3
    doc = {'asset': {'version': '2.0', 'generator': 'Trivor streamed dense geometry benchmark'}, 'scene': 0, 'scenes': [{'nodes': list(range(tiles))}], 'nodes': nodes, 'meshes': meshes, 'materials': materials, 'accessors': accessors, 'bufferViews': views, 'buffers': [{'byteLength': offset}], 'images': images, 'textures': [{'source': i} for i in range(4)], 'extras': {'benchmark': {'grid': grid, 'tiles': tiles, 'triangles': triangles, 'repeatedTileData': True, 'allPayloadReferenced': True}}}
    encoded = json.dumps(doc, separators=(',', ':')).encode()
    encoded += b' ' * (-len(encoded) % 4)
    total = 28 + len(encoded) + offset
    if total >= 2 ** 32:
        raise ValueError('GLB 32-bit length limit exceeded')
    if shutil.disk_usage(path.parent).free < total + 512 * 1024 * 1024:
        raise RuntimeError('Insufficient free space for fixture and verification')
    if path.exists():
        raise FileExistsError(path)
    temporary = path.with_suffix('.writing.glb')
    if temporary.exists():
        raise FileExistsError(temporary)
    digest = hashlib.sha256()
    started = time.monotonic()
    with temporary.open('xb', buffering=4 * 1024 * 1024) as output:
        def write(data):
            output.write(data)
            digest.update(data)
        write(struct.pack('<4sIII4s', b'glTF', 2, total, len(encoded), b'JSON'))
        write(encoded)
        write(struct.pack('<I4s', offset, b'BIN\x00'))
        binary_offset = 28 + len(encoded)
        previous = row_vertices(grid, 0)
        for row in range(grid):
            current = row_vertices(grid, row + 1)
            data = bytearray()
            for column in range(grid):
                # Counter-clockwise non-degenerate triangles on a wavy surface.
                data.extend(previous[column] + previous[column + 1] + current[column + 1])
                data.extend(previous[column] + current[column + 1] + current[column])
            write(data)
            previous = current
        output.flush()
        with temporary.open('rb', buffering=0) as first_tile:
            for tile in range(1, tiles):
                first_tile.seek(binary_offset)
                remaining = tile_bytes
                while remaining:
                    chunk = first_tile.read(min(4 * 1024 * 1024, remaining))
                    if not chunk:
                        raise RuntimeError('Unexpected EOF when repeating the first actual tile')
                    write(chunk)
                    remaining -= len(chunk)
                print(f'{path.name}: tile {tile + 1}/{tiles}', flush=True)
        for texture in textures:
            write(texture)
            write(b'\0' * (-len(texture) % 4))
        output.flush()
        os.fsync(output.fileno())
    temporary.rename(path)
    stat = path.stat()
    assert stat.st_size == total
    # Verifies allocation too: a sparse fake-header fixture is not a valid result.
    assert stat.st_blocks * 512 >= total * .95
    return {'path': str(path), 'bytes': total, 'allocatedBytes': stat.st_blocks * 512, 'geometryBytes': geometry_bytes, 'triangles': triangles, 'vertices': vertex_count * tiles, 'meshes': tiles, 'materials': tiles, 'textures': 4, 'grid': grid, 'sha256': digest.hexdigest(), 'generationSeconds': round(time.monotonic() - started, 3), 'generatorPeakRSSBytes': resource.getrusage(resource.RUSAGE_SELF).ru_maxrss, 'expectedBounds': [min(columns, tiles) * 1.02 - .02, math.ceil(tiles / columns) * 1.02 - .02, 2 * amplitude]}


def inspect(path):
    with path.open('rb') as source:
        magic, version, size, json_length, kind = struct.unpack('<4sIII4s', source.read(20))
        assert (magic, version, kind, size) == (b'glTF', 2, b'JSON', path.stat().st_size)
        doc = json.loads(source.read(json_length))
        bin_length, bin_kind = struct.unpack('<I4s', source.read(8))
        assert bin_kind == b'BIN\0' and bin_length + 28 + json_length == size
        binary_offset = source.tell()
        faces = sum(doc['accessors'][p.get('indices', p['attributes']['POSITION'])]['count'] // 3 for mesh in doc['meshes'] for p in mesh['primitives'])
        for mesh in doc['meshes']:
            for primitive in mesh['primitives']:
                position = doc['accessors'][primitive['attributes']['POSITION']]
                assert len(position['min']) == len(position['max']) == 3
                view = doc['bufferViews'][position['bufferView']]
                if 'extensions' not in view:
                    stride = view.get('byteStride', 12)
                    source.seek(binary_offset + view.get('byteOffset', 0) + position.get('byteOffset', 0))
                    vertices = [struct.unpack('<3f', source.read(stride)[:12]) for _ in range(3)]
                    a, b, c = vertices
                    ab, ac = [b[i] - a[i] for i in range(3)], [c[i] - a[i] for i in range(3)]
                    cross = [ab[1]*ac[2]-ab[2]*ac[1], ab[2]*ac[0]-ab[0]*ac[2], ab[0]*ac[1]-ab[1]*ac[0]]
                    assert sum(x*x for x in cross) > 0, vertices
        return {'triangles': faces, 'meshes': len(doc['meshes']), 'materials': len(doc.get('materials', [])), 'images': len(doc.get('images', [])), 'extensionsUsed': doc.get('extensionsUsed', []), 'jsonBytes': json_length, 'binaryBytes': bin_length}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('preset', choices=['large', 'browser'])
    parser.add_argument('--keep-raw', action='store_true')
    parser.add_argument('--output', type=Path, required=True, help='Output directory; large preset uses about 2 GiB')
    parser.add_argument('--gltfpack', type=Path, default=REPO / 'src-tauri/bin/gltfpack-aarch64-apple-darwin')
    args = parser.parse_args()
    root = args.output.resolve()
    root.mkdir(parents=True, exist_ok=True)
    grid, tiles = (592, 32) if args.preset == 'large' else (504, 4)
    source = root / ('dense-2gib.glb' if args.preset == 'large' else 'browser-2m-raw.glb')
    report = write_model(source, grid, tiles)
    report['validation'] = inspect(source)
    if args.preset == 'browser':
        compressed = root / 'browser-2m.glb'
        if compressed.exists():
            raise FileExistsError(compressed)
        started = time.monotonic()
        result = subprocess.run([str(args.gltfpack), '-i', str(source), '-o', str(compressed), '-cc', '-kn', '-km'], capture_output=True, text=True)
        if result.returncode:
            raise RuntimeError(result.stderr or result.stdout)
        report['compressed'] = {'path': str(compressed), 'bytes': compressed.stat().st_size, 'seconds': round(time.monotonic() - started, 3), 'peakRSSBytes': resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss, 'validation': inspect(compressed)}
        assert report['compressed']['validation']['triangles'] == report['triangles']
        assert 'EXT_meshopt_compression' in report['compressed']['validation']['extensionsUsed']
        if not args.keep_raw:
            source.unlink()
            report['rawDeletedAfterCompression'] = True
    target = root / f'{args.preset}-report.json'
    target.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
