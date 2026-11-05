# MCP dependency review — 2026-11-05 (#404)

Authenticated clients reach `McpServer` validation, including the `update_files`
array. Authentication and the per-IP rate limit do not prevent a signed-in caller
from submitting an expensive validation payload. This path is relevant to
[GHSA-46jr-4wx8-v453](https://github.com/modelcontextprotocol/typescript-sdk/security/advisories/GHSA-46jr-4wx8-v453).
The upstream fix requires enabling a limit as well as upgrading.

The Worker now pins SDK 1.32.2, agents 0.33.0 and Zod 4.6.7, with a single
legacy SDK copy shared by the app and agents. The legacy `McpAgent`/SQLite
session model is retained. The agents release also imports the v2 client/server
peers, so those are explicitly installed at its declared 2.4.0 versions; the
application continues to construct the supported v1 `McpServer`.

`maxToolInputElements` is explicitly 10,000. Before OAuth or MCP parsing,
`withBoundedBody` limits actual request bytes to 1 MiB, including chunked bodies
and inaccurate Content-Length. Oversized requests receive 413 with guidance to
split file updates; ordinary code strings are not counted as collection elements.
These are server request bounds, not restrictions on app architecture.

The SDK OAuth-client and experimental-task advisories do not describe enabled
features here: this is an OAuth-protected server, and it registers no task store.
The Node Express/body-parser/static-server paths are not deployed routes in this
Worker. Undici/Miniflare findings also affect local tooling. Compatible lockfile
updates were applied to those dependencies instead of leaving them unpatched or
using `audit fix --force`.

Validation: `npm audit` reports zero known findings for this lockfile; typecheck,
unit tests, and the deployment bundle pass. `npm run test:runtime` starts the
actual Worker/McpAgent with isolated SQLite storage and synthetic read-only props,
then exercises initialize, tools/list, a real SDK-guide call, the element limit
and HTTP body limit. The local-only harness bypasses OAuth; existing callback,
nonce, PKCE and scope tests cover that layer. It does not claim a new interactive
GitHub/Google OAuth login was completed. Production deployment remains gated on
these tests.
