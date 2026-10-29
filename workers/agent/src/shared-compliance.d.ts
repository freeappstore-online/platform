// Type-checking only. compliance.ts imports the shared checks from
// packages/compliance/src, and they import the FileSource *type* from
// lib/file-source.ts, so tsc checks that file too. Its fsFileSource (CLI only)
// imports these Node built-ins. The Worker never loads that module: the import
// is type-only and erased, so it isn't bundled (test:runtime and wrangler
// deploy would fail if it were). This Worker has no @types/node, so the
// modules are declared untyped here rather than mixing Node globals into it.
declare module "node:child_process";
declare module "node:fs/promises";
declare module "node:path";
declare module "node:util";
