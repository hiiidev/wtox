/**
 * wTox v1 Cloudflare Worker entrypoint.
 * Nothing here reads a .tox backup, Tox identity secret, or message plaintext.
 * The legacy Python backend is intentionally not imported.
 */
import { routeRequest } from "./router.ts";
export { EncryptedMailbox } from "./mailbox.ts";

export interface Env {
  MAILBOX: DurableObjectNamespace;
}

export default {
  async fetch(request: Request, _env: Env): Promise<Response> {
    return routeRequest(request);
  }
};
