import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page, Route } from "@playwright/test";

/**
 * The protocol v2 runtime form, served to the visual harness.
 *
 * The web create/edit dialogs render ONLY the server-described v2 form (task #8).
 * A runtime gets one when its admission row (`…/runtime-options`) carries the
 * `runtimeFormV2` marker; the form then loads from
 * `/servers/:s/machines/:m/runtime-forms/v2/:runtime` (edit: `/agents/:id/runtime-form`)
 * and its option lists from `…/option-sources/:sourceId`. Without all of that the
 * dialog shows "Runtime configuration is unavailable" and no runtime field exists
 * to measure — which reads like the fields not existing, not like a missing mock.
 *
 * Forms and option sources are the real server-generated fixtures in
 * packages/runtime-form/fixtures, not shapes invented here. Where a spec needs a
 * state no fixture captures (a live Claude model list, Built-in's provider
 * lists), it derives it from a fixture and says what it changed.
 */

const fixtureDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../runtime-form/fixtures");

type Json = Record<string, unknown>;

/** A packages/runtime-form/fixtures file, parsed fresh (callers may mutate it). */
export function runtimeFormFixture(name: string): Json {
  return JSON.parse(readFileSync(resolve(fixtureDir, name), "utf8")) as Json;
}

/**
 * A fixture option source turned live: same options, no status line. The only
 * Claude model list in the fixtures is a `fallback` (machine_offline) one, whose
 * status line and Retry would sit in every capture that is not about them.
 */
export function liveSource(name: string): Json {
  const { status: _status, reason: _reason, retryable: _retryable, ...rest } = runtimeFormFixture(name);
  return { ...rest, status: "live" };
}

/**
 * Built-in's option sources. The fixtures carry its form (builtin.form.json) but
 * no provider/model lists, so these follow that form's own pointers and its
 * visibility rule (`baseUrl` shows for the gateway providers) — the same shape
 * packages/web/src/features/agent/tests/schemaCreateAgentDialog.behavior.test.tsx (removed in the 2026-11 web DOM test prune) serves.
 *
 * `saved` adds a saved provider connection the way the server lists one under
 * capability `provider.saved_connection` (runtime-form README): value
 * `connection:<id>`, its underlying provider, and the "saved" group ahead of the
 * "direct" one.
 */
export function builtinSources(
  saved?: { connectionId: string; label: string; underlyingProviderId: string },
  schemaVersion = "builtin-pi.create.v3",
): Record<string, Json> {
  const head = { protocolVersion: 1, runtimeId: "builtin", schemaVersion };
  const savedValue = saved ? `connection:${saved.connectionId}` : null;
  const direct = (option: Json) => (saved ? { ...option, group: "direct" } : option);
  const deepseekModels = [{ value: "deepseek/deepseek-v4-pro", label: "DeepSeek V4 Pro" }];
  return {
    provider: {
      ...head, sourceId: "provider", kind: "select", pointer: "/providerId",
      options: [
        ...(saved ? [{
          value: savedValue, label: saved.label, providerKind: "preset",
          connectionId: saved.connectionId, underlyingProviderId: saved.underlyingProviderId, group: "saved",
        }] : []),
        direct({ value: "deepseek", label: "DeepSeek", providerKind: "preset" }),
        direct({ value: "openai-compatible", label: "OpenAI Compatible", providerKind: "gateway" }),
      ],
      defaultValue: "deepseek",
      status: "live",
    },
    model: {
      ...head, sourceId: "model", kind: "dependent_select", pointer: "/model", dependsOn: "/providerId",
      optionsByValue: {
        ...(savedValue ? { [savedValue]: deepseekModels } : {}),
        deepseek: deepseekModels,
        "openai-compatible": [],
      },
      defaultValueByValue: {
        ...(savedValue ? { [savedValue]: "deepseek/deepseek-v4-pro" } : {}),
        deepseek: "deepseek/deepseek-v4-pro",
      },
      customValueAllowedByValue: {
        ...(savedValue ? { [savedValue]: false } : {}),
        deepseek: false,
        "openai-compatible": true,
      },
      status: "live",
    },
  };
}

export type RuntimeFormV2Mock = {
  runtimeId: string;
  /** The create form (`…/runtime-forms/v2/:runtimeId`). */
  form?: Json;
  /** The edit form (`/agents/:id/runtime-form`), for Agent Details. */
  edit?: Json;
  /** sourceId → option source body, or a status code to fail that request with. */
  sources?: Record<string, Json | number>;
  /** Admission row: this agent's current runtime (edit context). */
  current?: boolean;
};

/** One admission row, marked as served on protocol v2. */
export function runtimeOptionRow(runtimeId: string, current = false) {
  return {
    runtimeId,
    capabilityStatus: "available",
    admissionStatus: "available_for_new",
    admissionReason: null,
    current,
    availableForNew: true,
    manageableForCurrentAgent: current,
    canSelectInThisContext: true,
    runtimeFormV2: { protocolVersion: 2 },
  };
}

const RUNTIME_OPTIONS = /\/runtime-options$/;
const V2_FORM = /\/runtime-forms\/v2\/([^/]+)(?:\/option-sources\/([^/]+))?$/;
const EDIT_FORM = /\/agents\/[^/]+\/runtime-form$/;

/**
 * The response for one runtime-form request, or null when `pathname` is not one.
 * Exposed for react-provider.spec.ts, whose single catch-all route cannot use
 * `mockRuntimeFormsV2` without being shadowed by it.
 */
export function runtimeFormV2Response(
  pathname: string,
  runtimes: readonly RuntimeFormV2Mock[],
): { status: number; body: unknown } | null {
  if (RUNTIME_OPTIONS.test(pathname)) {
    const machineId = pathname.split("/machines/")[1]?.split("/")[0] ?? null;
    return {
      status: 200,
      body: {
        context: machineId ? "new_agent" : "existing_agent",
        machineId,
        options: runtimes.map((runtime) => runtimeOptionRow(runtime.runtimeId, runtime.current)),
      },
    };
  }
  if (EDIT_FORM.test(pathname)) {
    const edit = runtimes.find((runtime) => runtime.edit)?.edit;
    return edit ? { status: 200, body: edit } : { status: 404, body: { code: "not_found" } };
  }
  const match = V2_FORM.exec(pathname);
  if (!match) return null;
  const runtime = runtimes.find((candidate) => candidate.runtimeId === decodeURIComponent(match[1]));
  const sourceId = match[2] ? decodeURIComponent(match[2]) : null;
  if (!runtime) return { status: 404, body: { code: "not_found" } };
  if (!sourceId) return runtime.form ? { status: 200, body: runtime.form } : { status: 404, body: { code: "not_found" } };
  const source = runtime.sources?.[sourceId];
  if (source === undefined) return { status: 404, body: { code: "not_found" } };
  return typeof source === "number" ? { status: source, body: { code: "source_failed" } } : { status: 200, body: source };
}

/** Serve the given runtimes' v2 forms (and their admission rows) to this page. */
export async function mockRuntimeFormsV2(page: Page, runtimes: readonly RuntimeFormV2Mock[]) {
  await page.route("**/api/**", async (route: Route) => {
    const response = runtimeFormV2Response(new URL(route.request().url()).pathname, runtimes);
    if (!response) return route.fallback();
    return route.fulfill({ status: response.status, contentType: "application/json", body: JSON.stringify(response.body) });
  });
}

/** The Codex create form with its live model list: what the default dialog cases show. */
export const CODEX_LIVE: RuntimeFormV2Mock = {
  runtimeId: "codex",
  form: runtimeFormFixture("codex.form.json"),
  sources: { model: runtimeFormFixture("codex.option-source.live.json") },
};

/** The Claude create form with its provider / auth lists and a live model list. */
export const CLAUDE_LIVE: RuntimeFormV2Mock = {
  runtimeId: "claude",
  form: runtimeFormFixture("claude.form.json"),
  sources: {
    provider: runtimeFormFixture("claude.option-source.provider.json"),
    authType: runtimeFormFixture("claude.option-source.auth-type.json"),
    model: liveSource("claude.option-source.fallback.json"),
  },
};
