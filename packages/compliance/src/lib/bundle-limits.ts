/**
 * Bundle-size caps shared by the source-side `fas check` and the live
 * audit. Keep them in one file so the two paths cannot drift.
 *
 * Initial load is the HTML entry chunk plus its static imports — the JS
 * the browser downloads before any `import()`, worker, or wasm fetch.
 * Lazy assets (dynamic chunks, workers, wasm, model/data files) are
 * allowed to be much larger because they only download when the user
 * opens that feature.
 */
export const INITIAL_LOAD_MAX_GZIP_BYTES = 300 * 1024; // 300 KB
export const LAZY_ASSET_MAX_BYTES = 25 * 1024 * 1024; // 25 MB per asset
