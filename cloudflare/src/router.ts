/**
 * Public routes for the new Workers backend.
 *
 * This backend is deliberately fail-closed. Mailbox, Tox relay, and
 * authentication endpoints stay inaccessible until client-side identity
 * proof and end-to-end encryption are implemented and independently tested.
 */
export const API_VERSION = "v1";

function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      ...extra
    }
  });
}

export function routeRequest(request: Request): Response {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path === "/api/v1/health" || path === "/api/v1/capabilities") {
    if (request.method !== "GET") {
      return json({ error: "method_not_allowed" }, 405, { Allow: "GET" });
    }
    if (path === "/api/v1/health") {
      return json({ status: "ok", service: "wtox-edge", version: API_VERSION });
    }
    return json({
      version: API_VERSION,
      api: "available",
      runtime: "cloudflare-workers",
      mailbox_storage: "internal_only",
      public_mailbox_api: "disabled",
      tox_wasm: "not_implemented",
      tox_tcp_bridge: "not_implemented",
      e2ee_devices: "not_implemented",
      web_push: "not_implemented"
    });
  }
  if (path.startsWith("/api/v1/mailboxes") ||
      path.startsWith("/api/v1/relay") ||
      path.startsWith("/api/v1/identity") ||
      path.startsWith("/api/v1/push")) {
    return json({
      error: "not_implemented",
      detail: "Disabled until device authentication, origin checks and end-to-end encryption are verified."
    }, 501);
  }
  return json({ error: "not_found" }, 404);
}
