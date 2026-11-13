import { RUNTIME_FORM_V2_CLIENT_CAPABILITIES_QUERY } from "@botiverse/raft-runtime-form";
import type { RuntimeFormV2AdvertisedClientCapability } from "@botiverse/raft-runtime-form";

/**
 * Capabilities this web client ADVERTISES to the server on every v2
 * definition, edit-form, option-source and submit request (task #10). Without
 * them the server serves the form as it did before each capability existed.
 */
export const WEB_RUNTIME_FORM_V2_ADVERTISED_CAPABILITIES: readonly RuntimeFormV2AdvertisedClientCapability[] = [
  // A dependent value with options that also takes a typed one is a combobox
  // that keeps its default (runtimeFormV2Choices): Built-in OpenRouter.
  "dependent_select.custom_value_with_options",
  // Protocol v3 shapes (rules, conditional required, the effort source,
  // unavailableOptions), rendered through the shared state.
  "runtime_form.v3",
];

/** The request params that advertise them (axios `params`). */
export function runtimeFormV2ClientCapabilityParams(): Record<string, string> {
  return { [RUNTIME_FORM_V2_CLIENT_CAPABILITIES_QUERY]: WEB_RUNTIME_FORM_V2_ADVERTISED_CAPABILITIES.join(",") };
}

/**
 * The request config for an agent create/edit save (task #10): a v2
 * runtime-form submit advertises the capabilities (the server's old-client
 * edit guard reads them); any other save is sent unchanged.
 */
export function runtimeFormV2SubmitRequestConfig(formDefinitionRef: unknown): { params: Record<string, string> } | undefined {
  const protocolVersion = typeof formDefinitionRef === "object" && formDefinitionRef !== null
    ? (formDefinitionRef as { protocolVersion?: unknown }).protocolVersion
    : undefined;
  const v2 = protocolVersion === 2 || protocolVersion === 3;
  return v2 ? { params: runtimeFormV2ClientCapabilityParams() } : undefined;
}
