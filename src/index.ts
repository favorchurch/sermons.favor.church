// Cloudflare D1/R2 bindings and public vars are generated from Wrangler config
// with `wrangler types` before tsc. Secrets are read at runtime, never in git.
import { handleRequest } from './auth/app.ts';

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env);
  }
} satisfies ExportedHandler<Env>;
