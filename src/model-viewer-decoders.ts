/**
 * Configure model-viewer decoders before the first <model-viewer> is created.
 * meshoptDecoderLocation is a script URL, unlike the Draco/KTX2 directory URLs.
 * Keep it local so preview-cache models work without a CDN connection.
 */
type ModelViewerGlobalConfig = {
  meshoptDecoderLocation?: string;
  dracoDecoderLocation?: string;
  ktx2TranscoderLocation?: string;
};

const globalScope = globalThis as typeof globalThis & {
  ModelViewerElement?: ModelViewerGlobalConfig;
};

const cfg: ModelViewerGlobalConfig = globalScope.ModelViewerElement ?? {};

cfg.meshoptDecoderLocation = "/decoders/meshopt/meshopt_decoder.js";
cfg.dracoDecoderLocation ??=
  "https://www.gstatic.com/draco/versioned/decoders/1.5.7/";
cfg.ktx2TranscoderLocation ??=
  "https://www.gstatic.com/basis-universal/versioned/2021-04-15-ba1c3e4/";

globalScope.ModelViewerElement = cfg;

export {};
