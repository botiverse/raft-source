/**
 * Stand-ins for the protocol v2 runtime form, the only runtime form the web
 * create/edit UI renders (task #8). Create and Save stay disabled until the
 * runtime's admission row carries the `runtimeFormV2` marker and its form has
 * loaded, so a test that only needs "a runnable runtime" uses these.
 */
export const RUNTIME_FORM_V2_MARKER = { runtimeFormV2: { protocolVersion: 2 as const } };

/** A minimal v2 form: one optional text field, so nothing has to be filled in. */
export function minimalRuntimeFormV2(runtimeId: string, values?: Record<string, unknown>) {
  return {
    protocolVersion: 2,
    runtimeId,
    schemaVersion: `${runtimeId}.v2-test`,
    dataSchema: { type: "object", properties: { model: { type: "string", title: "Model" } } },
    ...(values ? { values } : {}),
  };
}

/** The runtime a v2 create-form request is for (`…/runtime-forms/v2/<runtime>`), or null. */
export function runtimeFormV2RequestRuntime(url: string): string | null {
  return url.match(/\/runtime-forms\/v2\/([^/?]+)$/)?.[1] ?? null;
}

/** The minimal form as the answer to a v2 create-form request; null for any other URL. */
export function minimalRuntimeFormV2Response(url: string): { data: unknown } | null {
  const runtimeId = runtimeFormV2RequestRuntime(url);
  return runtimeId ? { data: minimalRuntimeFormV2(runtimeId) } : null;
}
