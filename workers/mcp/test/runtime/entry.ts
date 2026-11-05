// Local-only harness. Never the deployed entry point; no credentials or write scopes.
import { FasMcpAgent } from '../../src/index.js';
import { withBoundedBody } from '../../src/request-limits.js';
export { FasMcpAgent };
const route = FasMcpAgent.serve('/mcp');
export default {
  fetch(request: Request, env: unknown, ctx: ExecutionContext) {
    return withBoundedBody(request, (bounded) => route.fetch(bounded, env, {
      props: { userId: 'runtime-test', readOnly: true, scopes: ['read'] },
      waitUntil: ctx.waitUntil.bind(ctx), passThroughOnException: ctx.passThroughOnException.bind(ctx),
    } as ExecutionContext));
  },
};
