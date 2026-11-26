// Contribute's model worker (#826): the SDK's shared Kokoro worker, with ONNX Runtime's
// WebAssembly bundled with the app rather than loaded from a CDN.
import { serveKokoroWorker } from '@freeappstore/sdk/generation-kokoro/worker';

serveKokoroWorker({
  wasmPaths: {
    wasm: new URL(
      '../../node_modules/@huggingface/transformers/dist/ort-wasm-simd-threaded.jsep.wasm',
      import.meta.url,
    ).href,
    mjs: new URL(
      '../../node_modules/@huggingface/transformers/dist/ort-wasm-simd-threaded.jsep.mjs',
      import.meta.url,
    ).href,
  },
});
