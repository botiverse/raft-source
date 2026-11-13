import { isBuiltInRuntimeProviderId } from "@botiverse/raft-shared";

/**
 * Per-call request size for Pi on `anthropic-messages` (#runtime-watch:#1).
 *
 * pi-ai's default Anthropic message threads are on (for `api.anthropic.com`): a
 * session's first request opens a thread in full and each later one continues
 * it with only the new messages. Thread state lives in pi-ai's memory per
 * session id, and pi-ai alone handles a thread the server can no longer use: it
 * resends a rejected `continue` in full as a new thread, or without threads
 * (and turns them off for the session) on `thread_unsupported_request`. Raft
 * adds nothing to that.
 *
 * This module only measures each provider call: the bytes it put on the wire
 * (pi-ai's resends included), how many requests that took, the outcome and the
 * tokens the reply reports. No body, URL, header, id or error text leaves here:
 * sizes, counts, closed sets.
 */

/** `source` of the `provider_request` telemetry (`daemon.runtime.telemetry.provider_request`) this module measures. */
export const PI_ANTHROPIC_REQUEST_SOURCE = "pi_anthropic_request";

function bodyBytes(body: unknown): number | undefined {
  if (typeof body === "string") return Buffer.byteLength(body);
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (ArrayBuffer.isView(body)) return body.byteLength;
  return undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

interface CallScope {
  readonly provider: string;
  /** Wire bytes of each request this call sent (undefined where the body is not measurable). */
  readonly attempts: Array<number | undefined>;
}

/** One provider call's measurement, emitted as `daemon.runtime.telemetry.provider_request`. */
export type PiAnthropicRequestAttrs = Record<string, string | number | boolean>;

export interface PiAnthropicRequestMeterOptions {
  /** `AgentConfig.wakeRecycleWarm`, so a reader can split request size by it. */
  warmRecycleFlag: boolean;
  emitRequest: (attrs: PiAnthropicRequestAttrs) => void;
}

type ObservedOptions = { fetch?: unknown };
type ObservedStream = { result(): Promise<unknown> };

/**
 * Per Pi driver: wraps each `anthropic-messages` provider call's `fetch`
 * (Raft's provider HTTP client, which sees the wire body). Never changes a
 * request, and never lets a diagnostic sink fail a call.
 */
export class PiAnthropicRequestMeter {
  constructor(private readonly options: PiAnthropicRequestMeterOptions) {}

  /**
   * Run one provider call with `fetch` observed. Other APIs pass straight
   * through. `options.fetch` must already be Raft's fetch.
   */
  observe<O, S extends ObservedStream>(model: { api?: unknown; provider?: unknown }, options: O, invoke: (options: O) => S): S {
    if (model.api !== "anthropic-messages") return invoke(options);
    const fetchImpl = ((options ?? {}) as ObservedOptions).fetch as typeof fetch | undefined;
    if (typeof fetchImpl !== "function") return invoke(options);
    const scope: CallScope = {
      provider: typeof model.provider === "string" && isBuiltInRuntimeProviderId(model.provider) ? model.provider : "custom",
      attempts: [],
    };
    const observed = {
      ...options,
      fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
        scope.attempts.push(bodyBytes(init?.body));
        return fetchImpl(input, init);
      }) as typeof fetch,
    } as O;
    const stream = invoke(observed);
    try {
      Promise.resolve(stream.result()).then(
        (message) => this.end(scope, message),
        () => this.end(scope, undefined),
      ).catch(() => { /* An unavailable sink must not surface as an unhandled rejection. */ });
    } catch {
      this.end(scope, undefined);
    }
    return stream;
  }

  private end(scope: CallScope, message: unknown): void {
    try {
      if (scope.attempts.length === 0) return;
      const last = scope.attempts.at(-1);
      const stopReason = (message as { stopReason?: unknown } | null | undefined)?.stopReason;
      const completed = stopReason === "stop" || stopReason === "length" || stopReason === "toolUse";
      const usage = (message as { usage?: Record<string, unknown> } | null | undefined)?.usage;
      const attrs: PiAnthropicRequestAttrs = {
        provider: scope.provider,
        wake_recycle_warm: this.options.warmRecycleFlag,
        outcome: completed ? "completed" : stopReason === "aborted" ? "aborted" : "error",
        wire_requests_count: scope.attempts.length,
        request_bytes: scope.attempts.reduce<number>((sum, bytes) => sum + (bytes ?? 0), 0),
        ...(last !== undefined ? { last_request_bytes: last } : {}),
      };
      for (const [wireKey, attrKey] of [["input", "input_tokens"], ["output", "output_tokens"], ["cacheRead", "cached_read_tokens"], ["cacheWrite", "cache_write_tokens"]] as const) {
        const value = finite(usage?.[wireKey]);
        if (value !== undefined) attrs[attrKey] = value;
      }
      this.options.emitRequest(attrs);
    } catch { /* Observation never affects the call. */ }
  }
}
