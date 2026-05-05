# rooms-demo

Minimal example for `@freeappstore/sdk`: GitHub sign-in, joining a Durable-Object-backed room, broadcasting messages, seeing live peers.

## Run locally

You need the backend Worker running locally first:

```bash
# In a separate shell
pnpm --filter @freeappstore/backend dev
```

Then this example:

```bash
pnpm --filter @freeappstore-examples/rooms-demo dev
```

Open `http://localhost:5173`. Edits to the SDK source under `packages/sdk/src/` hot-reload — `vite.config.ts` aliases `@freeappstore/sdk` to the source.

## Configuration

By default the example points at `http://localhost:8787` (wrangler dev). To target a deployed API:

```bash
VITE_FAS_API=https://api.freeappstore.online pnpm --filter @freeappstore-examples/rooms-demo dev
```

## Prerequisites for sign-in to actually work

The Worker needs a registered GitHub OAuth App and Worker secrets. See the root README for the one-time admin setup. Until that's done, clicking "Sign in with GitHub" will redirect to a 400 from the Worker.
