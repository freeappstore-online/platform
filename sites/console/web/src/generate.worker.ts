// The Generate page's model worker (#795): the SDK's shared Kokoro runner, with ONNX Runtime's
// WebAssembly served from the console rather than a CDN. Not precached (vite.config.ts): only
// creators who generate download it.
import { serveKokoroWorker } from '@freeappstore/sdk/generation-kokoro/worker'

serveKokoroWorker({
  wasmPaths: {
    wasm: new URL('../node_modules/@huggingface/transformers/dist/ort-wasm-simd-threaded.jsep.wasm', import.meta.url).href,
    mjs: new URL('../node_modules/@huggingface/transformers/dist/ort-wasm-simd-threaded.jsep.mjs', import.meta.url).href,
  },
})
