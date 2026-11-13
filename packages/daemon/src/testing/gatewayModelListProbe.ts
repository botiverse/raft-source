import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Test-only: a Built-in gateway session reads the gateway's model list
 * (`GET <Base URL>/models`, `/v1/models?limit=1000`; #proj-runtime:#53) before
 * its first model call. A fake gateway whose handler scripts or counts model
 * calls answers that read with 404 here first, so its script and counts stay
 * about model calls. Returns true when it answered.
 */
export function answerGatewayModelListRead(req: IncomingMessage, res: ServerResponse): boolean {
  if (req.method !== "GET" || !/\/models(?:\?|$)/.test(req.url ?? "")) return false;
  req.resume();
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
  return true;
}
