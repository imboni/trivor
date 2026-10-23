# Large-model loading

**English** · [简体中文](large-models.zh-Hans.md)

## Progressive previews

For large GLB / glTF assets, including roughly 2 GB inputs, loading has three stages:

1. **Structure overview (bounding boxes)** reads JSON bounds and node transforms without loading geometry BIN data. The UI identifies these as boxes, not real surfaces.
2. **Geometry preview** builds a smaller mesh/texture representation in the background.
3. **Detailed preview (simplified)** rebuilds a finer representation from the original source. The foreground stays interactive; replacement preserves the live camera and initial Reset pose.

Stop refinement at any time. Switching or closing a model cancels the previous preparation. Failed refinement leaves the current stage visible; reopen the same file to retry. Reopening reuses the highest validated cache stage. Source and external-resource changes invalidate caches.

Sources remain unchanged. GLB/glTF exports use the original asset; transparent PNG exports capture the visible stage. Detail replacement waits for active high-resolution capture.

## Trigger and budgets

Preparation starts when any of these thresholds is exceeded, including compressed meshopt inputs:

- 200 MiB of source/dependency bytes or declared buffer bytes;
- 2 million triangles across scene instances;
- 128 MiB of estimated decoded geometry or textures;
- 512 scene draw calls or 10,000 instances.

Each output is checked before its cache is published:

| Stage | Triangles | Geometry | Textures | Maximum texture edge | Draw calls |
| --- | ---: | ---: | ---: | ---: | ---: |
| Geometry preview | 300,000 | 64 MiB | 64 MiB | 512 px | 1,024 |
| Detailed preview | 2,000,000 | 256 MiB | 256 MiB | 1,024 px | 4,096 |

Many textures reduce the per-image edge further. Budgets estimate decoded memory including mipmaps, not just compressed file size. Unknown dimensions never count as zero. Preview textures use WebP encoding in memory to avoid sandbox temporary-file failures. A Basis transcoder is also bundled for offline KTX2 inputs. Over-budget outputs stop refinement instead of sending the original multi-gigabyte asset directly to the viewport.

## Limits

- These are progressively finer **simplified previews**, not lossless spatial tiles or view-dependent streaming. Full original fidelity is not promised.
- gltfpack still reads the full input. Conversion memory differs from the viewport budget; only one large conversion runs at a time.
- Missing bounds or GPU instancing skip the structure stage rather than display incorrect boxes. At most 2,048 boxes are shown; excess boxes aggregate into overall bounds.
- Required Draco compression cannot currently be optimized by the converter. An available overview remains visible when refinement fails. Small Draco assets retain their existing loading path.
- This large-model pipeline targets GLB/glTF. Large OBJ/STL inputs ask for conversion to GLB/glTF first; small inputs remain supported.
- Large inline-base64 `.gltf` metadata is scanned with bounded memory but still requires sequential I/O. It cannot match a GLB's independent JSON chunk for first overview latency.
- Lossless full-detail streaming requires a separate tiled rendering architecture.

## Measurements

On 2026-09-30, Apple Silicon with 32 GiB RAM: a generated, physically allocated 2.005 GiB GLB contained 22,429,696 nondegenerate triangles, 32 meshes/materials and four textures. All geometry bytes are referenced; this is not a sparse/padded size-only fixture.

- Structure preparation: about 3 ms, excluding app startup and first rendered frame.
- Geometry preview: 9.99 s, 284,960 triangles; process-tree maximum RSS about 4.45 GiB.
- Detailed preview: 9.05 s, 1,899,968 triangles; maximum RSS about 5.41 GiB.
- Warm cache returns the detailed stage in under 1 ms of preparation time.
- Cancellation requested at 500 ms returned at about 557 ms with temporary cache cleanup.

These synthetic geometry results do not guarantee equal performance for every 2 GB CAD, scan or animation asset. See [tests/README.md](../tests/README.md) for browser/native validation.
