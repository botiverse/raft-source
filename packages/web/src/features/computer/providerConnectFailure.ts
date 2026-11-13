import type { RuntimeAuthProviderConnectResult, RuntimeAuthProvidersResult } from "@botiverse/raft-shared";
import type { MessageId } from "../../i18n/messages/en";
import { runtimeAuthRequestError } from "../../utils/runtimeAuthClient";

/**
 * How a provider list or connect (Qwen Code's provider key, a Pi provider's
 * API key) that did not complete is worded: only the request's status and
 * code, or the Computer's result, are read, never the request.
 */

/** Why a provider list or connect stopped, and whether trying again could help. */
export interface ProviderFailure {
  messageId: MessageId;
  retryable: boolean;
}

/** A field the server refused, by the code it answered with. */
export type ProviderField = "apiKey" | "baseUrl" | "model";
const FIELD_BY_CODE: Record<string, ProviderField> = {
  invalid_api_key: "apiKey",
  invalid_base_url: "baseUrl",
  invalid_model: "model",
};
export const FIELD_MESSAGE: Record<ProviderField, MessageId> = {
  apiKey: "machine.runtimeAuth.provider.field.apiKey",
  baseUrl: "machine.runtimeAuth.provider.field.baseUrl",
  model: "machine.runtimeAuth.provider.field.model",
};

/**
 * A request the server refused or could not relay. Only its status and code
 * are read, never the request. A connect the server stopped waiting for may
 * still finish on the Computer, so it says so.
 */
export function providerRequestFailure(error: unknown, phase: "list" | "connect"): ProviderFailure | { field: ProviderField } {
  const { status, code } = runtimeAuthRequestError(error);
  const field = code ? FIELD_BY_CODE[code] : undefined;
  if (field) return { field };
  if (code === "computer_offline") return { messageId: "machine.runtimeAuth.error.computerOffline", retryable: true };
  if (code === "computer_upgrade_required") return { messageId: "machine.runtimeAuth.provider.upgradeRequired", retryable: false };
  if (code === "computer_not_attached") return { messageId: "machine.runtimeAuth.provider.notAttached", retryable: false };
  if (code === "computer_timeout" || status === 504) {
    return { messageId: phase === "connect" ? "machine.runtimeAuth.provider.error.connectTimedOut" : "machine.runtimeAuth.provider.error.computerTimeout", retryable: true };
  }
  if (code === "rate_limited" || status === 429) return { messageId: "machine.runtimeAuth.provider.error.rateLimited", retryable: true };
  if (status === 400) return { messageId: "machine.runtimeAuth.provider.error.invalidInput", retryable: true };
  if (status === 403) return { messageId: "machine.runtimeAuth.provider.error.forbidden", retryable: false };
  if (status === 404) return { messageId: "machine.runtimeAuth.error.notFound", retryable: false };
  return { messageId: "machine.runtimeAuth.provider.error.requestFailed", retryable: true };
}

/** The Computer answered, but without a list or a save. */
export function providerResultFailure(
  result: Exclude<RuntimeAuthProvidersResult | RuntimeAuthProviderConnectResult, { kind: "listed" } | { kind: "connected" }>,
  phase: "list" | "connect",
): ProviderFailure {
  if (result.kind === "busy") return { messageId: "machine.runtimeAuth.provider.error.busy", retryable: true };
  if (result.kind === "unsupported") {
    return result.reason === "not_installed"
      ? { messageId: "machine.runtimeAuth.error.notInstalled", retryable: false }
      : { messageId: "machine.runtimeAuth.provider.error.unsupported", retryable: false };
  }
  switch (result.reason) {
    case "rejected": return { messageId: "machine.runtimeAuth.provider.error.rejected", retryable: true };
    case "timed_out": return phase === "list"
      ? { messageId: "machine.runtimeAuth.provider.error.listTimedOut", retryable: true }
      : { messageId: "machine.runtimeAuth.provider.error.connectTimedOut", retryable: true };
    case "process_failed": return { messageId: "machine.runtimeAuth.provider.error.processFailed", retryable: true };
    case "invalid_response": return { messageId: "machine.runtimeAuth.provider.error.invalidResponse", retryable: false };
    // The server could not hand the connect to the Computer's own connection: nothing was saved.
    case "relay_failed": return { messageId: "machine.runtimeAuth.provider.error.requestFailed", retryable: true };
  }
}

