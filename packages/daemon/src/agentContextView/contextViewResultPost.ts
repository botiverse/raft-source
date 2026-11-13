import { promisify } from "node:util";
import { gzip } from "node:zlib";
import {
  AGENT_CONTEXT_VIEW_UNCOMPRESSED_BYTES_HEADER,
  agentContextViewResultPath,
  type AgentContextViewRequestId,
  type AgentContextViewResultBody,
} from "@botiverse/raft-shared";

const gzipAsync = promisify(gzip);

/** The result POST gives up after this; the request then ends `expired` on the Server. */
export const AGENT_CONTEXT_VIEW_POST_TIMEOUT_MS = 30_000;

export type ContextViewFetch = (input: URL, init: RequestInit) => Promise<Response>;

export interface ContextViewPostInput {
  serverUrl: string;
  /** The Computer credential (machine key), as every /internal/computer route. */
  apiKey: string;
  requestId: AgentContextViewRequestId;
  /** The body already serialized (the caller checked its size against the request's cap). */
  json: string;
  fetchImpl: ContextViewFetch;
  timeoutMs?: number;
}

export type ContextViewPostOutcome =
  | { outcome: "accepted"; status: number; compressedBytes: number }
  /** The Server answered with an error status (410 expired, 409 already answered, 404, 413 ...). Never retried. */
  | { outcome: "refused"; status: number; compressedBytes: number }
  /** No answer (network, timeout). Never retried. */
  | { outcome: "failed"; errorClass: string; compressedBytes: number };

export function serializeContextViewResult(body: AgentContextViewResultBody): string {
  return JSON.stringify(body);
}

/**
 * The one result POST for a request: gzip, the uncompressed length as a
 * hint header, a 30 s budget, and exactly one attempt. The Server accepts
 * only the first POST for a request id and ends the request on its own at
 * the TTL, so a retry could only collide or arrive late; the caller traces
 * the outcome and drops it.
 */
export async function postContextViewResult(input: ContextViewPostInput): Promise<ContextViewPostOutcome> {
  const raw = Buffer.from(input.json, "utf8");
  let compressed: Buffer;
  try {
    compressed = await gzipAsync(raw);
  } catch (error) {
    return { outcome: "failed", errorClass: error instanceof Error ? error.name : "Error", compressedBytes: 0 };
  }
  const url = new URL(agentContextViewResultPath(input.requestId), input.serverUrl);
  try {
    const response = await input.fetchImpl(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${input.apiKey}`,
        "Content-Type": "application/json",
        "Content-Encoding": "gzip",
        [AGENT_CONTEXT_VIEW_UNCOMPRESSED_BYTES_HEADER]: String(raw.length),
        "X-Raft-Client": "daemon-agent-context-view",
      },
      body: new Uint8Array(compressed),
      signal: AbortSignal.timeout(input.timeoutMs ?? AGENT_CONTEXT_VIEW_POST_TIMEOUT_MS),
    });
    // The answer carries nothing the daemon needs; release the connection.
    await response.body?.cancel().catch(() => undefined);
    return response.ok
      ? { outcome: "accepted", status: response.status, compressedBytes: compressed.length }
      : { outcome: "refused", status: response.status, compressedBytes: compressed.length };
  } catch (error) {
    return { outcome: "failed", errorClass: error instanceof Error ? error.name : "Error", compressedBytes: compressed.length };
  }
}
