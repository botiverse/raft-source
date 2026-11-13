import { useCallback, useEffect, useMemo, useState } from "react";
import { missingRuntimeFormV2Capabilities, parseRuntimeFormV2 } from "@botiverse/raft-runtime-form";
import type {
  ParsedRuntimeFormV2,
  RuntimeFormV2OptionSource,
  RuntimeFormV2Sources,
} from "@botiverse/raft-runtime-form";

import api from "../api/client";
import { runtimeFormV2ClientCapabilityParams } from "../utils/runtimeFormV2ClientCapabilities";
import { useLocale } from "../i18n/LocaleProvider";
import { htmlLangForLocale } from "../i18n/locale";
import type { Locale } from "../i18n/locale";
import { useServerStore } from "../store/serverStore";

/**
 * `requiredClientCapabilities` this web client implements. A v2 form that needs
 * anything else is unavailable here: the caller shows the form-unavailable
 * notice and blocks create/save (packages/runtime-form README, "Protocol v2").
 */
export const WEB_RUNTIME_FORM_V2_CAPABILITIES: ReadonlySet<string> = new Set<string>([
  // Combobox for a select whose source allows a typed value (RuntimeFormV2Fields).
  "select.custom_value",
  // Choice labels and descriptions from FieldCopy.choices (runtimeFormV2Choices).
  "choice.labels",
  // Per-source status, retry and submit blocking (this hook + RuntimeFormV2Fields).
  "option_source.status",
  // Saved provider connection options, connection-owned field handling and
  // the formRevision echo (this hook + RuntimeFormV2Fields).
  "provider.saved_connection",
]);

export type RuntimeFormV2State =
  | { status: "idle" }
  | { status: "loading" }
  | {
      status: "ready";
      form: ParsedRuntimeFormV2;
      sources: RuntimeFormV2Sources;
      /** `option_source.status`: re-request one source with `?refresh=1`. */
      retrySource?: (sourceId: string) => void;
      /** Sources being re-requested right now. */
      retryingSourceIds?: readonly string[];
    }
  | {
      status: "error";
      errorCode?: string;
      /** Fetch the whole form again (a failed load, e.g. a network error). */
      reload?: () => void;
    }
  /**
   * The form needs client capabilities this build lacks. There is no other form
   * to fall back to: shown as unavailable, and create/save stay blocked.
   */
  | { status: "unsupported"; missingCapabilities: string[] };

/**
 * A runtime whose admission row has no v2 form marker (no catalog runtime today):
 * nothing to load, so it is shown and blocked like an unsupported form.
 */
export const RUNTIME_FORM_V2_UNAVAILABLE: RuntimeFormV2State = { status: "unsupported", missingCapabilities: [] };

/**
 * v2 form copy is server-sent: ask for it in the app's display language, not the
 * browser's (which the browser would send by default).
 */
export function runtimeFormV2RequestHeaders(locale: Locale): Record<string, string> {
  return { "Accept-Language": htmlLangForLocale(locale) };
}

type RequestHeaders = Record<string, string>;

const runtimeFormV2Base = (serverId: string, machineId: string, runtimeId: string) =>
  `/servers/${serverId}/machines/${machineId}/runtime-forms/v2/${encodeURIComponent(runtimeId)}`;

/**
 * A source whose request failed (any form; per-source status is always on):
 * the same "unavailable" the server would send, retryable, without a reason
 * (shown as a generic message). The form stays usable around it.
 */
function unreachableSource(form: ParsedRuntimeFormV2, sourceId: string): RuntimeFormV2OptionSource {
  const ref = form.optionSources[sourceId];
  const pointer = `/${ref?.key ?? sourceId}`;
  return ref?.kind === "dependent_select"
    ? { sourceId, kind: "dependent_select", pointer, dependsOn: `/${ref.dependsOn ?? ""}`, optionsByValue: {}, status: "unavailable", retryable: true }
    : { sourceId, kind: "select", pointer, options: [], defaultValue: "", status: "unavailable", retryable: true };
}

async function loadRuntimeFormV2Source(
  base: string,
  form: ParsedRuntimeFormV2,
  sourceId: string,
  refresh: boolean,
  headers: RequestHeaders,
): Promise<RuntimeFormV2OptionSource> {
  // A revisioned form echoes its token (Definition.revision, capability
  // provider.saved_connection): the server answers within the form's declared
  // capability range or says the form is stale. An unrevisioned form keeps the
  // plain protocol.
  const query = new URLSearchParams();
  if (refresh) query.set("refresh", "1");
  if (form.revision) query.set("formRevision", form.revision);
  const suffix = query.toString();
  const url = `${base}/option-sources/${encodeURIComponent(sourceId)}${suffix ? `?${suffix}` : ""}`;
  try {
    const { data } = await api.get(url, { headers, params: runtimeFormV2ClientCapabilityParams() });
    return data as RuntimeFormV2OptionSource;
  } catch (error) {
    // Per-source status is always supported: a failed source marks only its
    // own field unavailable, never the whole form. A stale revision always
    // propagates: the caller refetches the whole form.
    if (isFormRevisionStale(error)) throw error;
    return unreachableSource(form, sourceId);
  }
}

/** 409 form_revision_stale: the server's form build moved on; refetch the whole form. */
function isFormRevisionStale(error: unknown): boolean {
  return (error as { response?: { data?: { code?: unknown } } }).response?.data?.code === "form_revision_stale";
}

async function loadRuntimeFormV2(
  base: string,
  headers: RequestHeaders,
  agentId?: string,
  attempt = 0,
): Promise<Exclude<RuntimeFormV2State, { status: "idle" | "loading" }>> {
  // Edit reads the same form plus the agent's current values from the agent itself.
  const { data } = await api.get(agentId ? `/agents/${encodeURIComponent(agentId)}/runtime-form` : base, { headers, params: runtimeFormV2ClientCapabilityParams() });
  const form = parseRuntimeFormV2(data);
  if (!form) return { status: "error" };
  const missingCapabilities = missingRuntimeFormV2Capabilities(form, WEB_RUNTIME_FORM_V2_CAPABILITIES);
  // Checked before any option source is loaded: an unavailable form is not rendered at all.
  if (missingCapabilities.length > 0) return { status: "unsupported", missingCapabilities };
  // Each source loads on its own: one failing source
  // is reported on its field (loadRuntimeFormV2Source) and never fails the form.
  try {
    const sources = Object.fromEntries(await Promise.all(Object.keys(form.optionSources).map(async (sourceId) =>
      [sourceId, await loadRuntimeFormV2Source(base, form, sourceId, false, headers)] as const)));
    return { status: "ready", form, sources, retryingSourceIds: [] };
  } catch (error) {
    // The form went stale between fetches (a flag flip mid-session): refetch
    // the whole form once. Options are never merged across builds.
    if (isFormRevisionStale(error) && attempt < 1) return loadRuntimeFormV2(base, headers, agentId, attempt + 1);
    throw error;
  }
}

/**
 * Protocol v2 create form for one runtime on one Computer: the current form as
 * the server describes it, plus its option lists. Tolerant by contract; only a
 * body that is not a v2 form at all, or a failed request, is an error. A form
 * requiring client capabilities this build lacks is "unsupported" (unavailable:
 * the caller blocks create/save; there is no legacy form to fall back to).
 */
export function useRuntimeFormV2(
  machineId: string | null | undefined,
  runtimeId: string | null,
  agentId?: string,
): RuntimeFormV2State {
  const serverId = useServerStore((state) => state.current?.id);
  const { locale } = useLocale();
  // The locale is part of the key: switching language reloads the form's copy.
  // `attempt` is bumped by `reload`: a new key refetches the whole form.
  const [attempt, setAttempt] = useState(0);
  const reload = useCallback(() => setAttempt((value) => value + 1), []);
  const requestKey = serverId && machineId && runtimeId ? `${serverId}\0${machineId}\0${runtimeId}\0${agentId ?? ""}\0${locale}\0${attempt}` : "";
  const [state, setState] = useState<{ requestKey: string; value: RuntimeFormV2State }>({ requestKey: "", value: { status: "idle" } });

  // One snapshot per request key; each branch replaces the whole object.
  // oxlint-disable-next-line react-doctor/no-cascading-set-state
  useEffect(() => {
    if (!serverId || !machineId || !runtimeId) return;
    let cancelled = false;
    // A mid-session form rebuild (a flag flip) is recovered by refetching the
    // whole form; bounded so a flapping server cannot loop the panel.
    let staleReloads = 0;
    // Bumped on every whole-form (re)install: an option-source response from a
    // previous generation (a retry that was still in flight across a stale
    // reload) is discarded instead of being merged into the newer form.
    let generation = 0;
    setState({ requestKey, value: { status: "loading" } });
    const base = runtimeFormV2Base(serverId, machineId, runtimeId);
    const headers = runtimeFormV2RequestHeaders(locale);
    // Updates the ready snapshot of this request only; a later request key wins.
    const updateReady = (update: (ready: Extract<RuntimeFormV2State, { status: "ready" }>) => RuntimeFormV2State) =>
      setState((previous) => previous.requestKey === requestKey && previous.value.status === "ready"
        ? { requestKey, value: update(previous.value) }
        : previous);
    const reinstall = (loaded: Exclude<RuntimeFormV2State, { status: "idle" | "loading" }>): void => {
      if (cancelled) return;
      generation += 1;
      const gen = generation;
      if (loaded.status !== "ready") {
        setState({ requestKey, value: loaded });
        return;
      }
      const inFlight = new Set<string>();
      // Sources whose list is keyed by this source's field (v3: a reasoning
      // effort keyed by model); re-requested once their parent answers.
      const dependentsOf = (sourceId: string) => {
        const key = loaded.form.optionSources[sourceId]?.key;
        return Object.values(loaded.form.optionSources).filter((ref) => key !== undefined && ref.dependsOn === key).map((ref) => ref.sourceId);
      };
      const reloadSource = (sourceId: string, refresh: boolean) => {
        if (cancelled || gen !== generation || inFlight.has(sourceId)) return;
        inFlight.add(sourceId);
        updateReady((ready) => ({ ...ready, retryingSourceIds: [...inFlight] }));
        void loadRuntimeFormV2Source(base, loaded.form, sourceId, refresh, headers)
          .then(
            (source) => {
              inFlight.delete(sourceId);
              if (cancelled || gen !== generation) return;
              updateReady((ready) => ({ ...ready, sources: { ...ready.sources, [sourceId]: source }, retryingSourceIds: [...inFlight] }));
              // The parent's fresh answer is cached server-side: dependents
              // follow without asking the Computer again.
              for (const dependent of dependentsOf(sourceId)) reloadSource(dependent, false);
            },
            (error: unknown) => {
              inFlight.delete(sourceId);
              if (cancelled || gen !== generation) return;
              // A stale revision means the whole form moved on: refetch it
              // (once more) instead of degrading one source and merging it
              // into a build the server no longer serves.
              if (isFormRevisionStale(error)) {
                if (staleReloads < 1) {
                  staleReloads += 1;
                  // Retire every callback from this form before starting recovery.
                  generation += 1;
                  // The form in hand is known-stale: drop to loading so nothing
                  // can be edited or submitted against it while the whole form
                  // is refetched.
                  setState({ requestKey, value: { status: "loading" } });
                  loadRuntimeFormV2(base, headers, agentId).then(reinstall, reinstallError);
                  return;
                }
                // Recovery budget exhausted: a known-stale form must never
                // stay editable (and a stale source must never merge into
                // it) — surface the form-level error state instead.
                setState({ requestKey, value: { status: "error", errorCode: "form_revision_stale" } });
                return;
              }
              updateReady((ready) => ({
                ...ready,
                sources: { ...ready.sources, [sourceId]: unreachableSource(loaded.form, sourceId) },
                retryingSourceIds: [...inFlight],
              }));
            },
          );
      };
      const retrySource = (sourceId: string) => reloadSource(sourceId, true);
      setState({ requestKey, value: { ...loaded, retrySource } });
    };
    const reinstallError = (error: unknown): void => {
      if (cancelled) return;
      const code = (error as { response?: { data?: { code?: unknown } } }).response?.data?.code;
      setState({ requestKey, value: { status: "error", ...(typeof code === "string" ? { errorCode: code } : {}) } });
    };
    loadRuntimeFormV2(base, headers, agentId).then(reinstall, reinstallError);
    return () => { cancelled = true; };
  }, [agentId, locale, machineId, requestKey, runtimeId, serverId]);

  // A stable object per snapshot, so a caller's effects do not rerun every render.
  const value = useMemo(
    () => state.value.status === "error" ? { ...state.value, reload } : state.value,
    [reload, state.value],
  );
  if (!requestKey) return { status: "idle" };
  if (state.requestKey !== requestKey) return { status: "loading" };
  return value;
}
