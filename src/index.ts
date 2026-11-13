// Phase 0: no data routes. Add authenticated tenancy checks before any API surface.
// This handler intentionally does not bind or query D1/R2 yet.
const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer"
};

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return new Response(JSON.stringify({ status: "ok", app: "sermon-bank" }), {
        status: 200,
        headers: JSON_HEADERS
      });
    }
    return new Response(JSON.stringify({ error: "not_found" }), {
      status: 404,
      headers: JSON_HEADERS
    });
  }
};
