import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import "./helpers/domSetup";
import { cleanup, render, waitFor } from "@testing-library/react";
import type { Server, ServerModelLabelCatalog } from "@botiverse/raft-shared";
import api from "../src/api/client";
import { useRuntimeFormV2 } from "../src/hooks/useRuntimeFormV2";
import { useModelLabelCatalogStore } from "../src/store/modelLabelCatalogStore";
import { useServerStore } from "../src/store/serverStore";
import { TestIntlProvider } from "./helpers/intl";

// #triage:#548: after Claude Code was upgraded on a Computer, the runtime
// config dropdown said "Fable 5.2" (its option list is a live detect the server
// stores in the shared model-label catalog) while the chat and profile kept
// the catalog the web had fetched before and said "Fable 5.1". Opening the
// form with a live model list now reloads the web's catalog copy.

const SERVER_ID = "server-1";
const MACHINE_ID = "machine-1";
const AGENT_ID = "agent-1";
const CATALOG_URL = `/servers/${SERVER_ID}/model-label-catalog`;

type Json = Record<string, unknown>;
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../../runtime-form/fixtures/${name}`, import.meta.url), "utf8")) as Json;

/** The server's real Claude answers: static provider and auth type (no status), a model list that is live or a fallback. */
function sourceFixture(sourceId: string, model: "live" | "fallback"): Json | undefined {
  if (sourceId === "provider") return fixture("claude.option-source.provider.json");
  if (sourceId === "authType") return fixture("claude.option-source.auth-type.json");
  if (sourceId === "model") return fixture(`claude.option-source.${model}.json`);
  return undefined;
}

const stale: ServerModelLabelCatalog = { machines: { [MACHINE_ID]: { runtimes: {} } } };
const originalGet = api.get.bind(api);
let catalogFetches = 0;

function serve(model: "live" | "fallback") {
  api.get = (async (url: string) => {
    if (url === `/agents/${AGENT_ID}/runtime-form`) return { data: fixture("claude.edit.json") };
    if (url === CATALOG_URL) {
      catalogFetches += 1;
      return { data: stale };
    }
    const sourceId = /\/option-sources\/([^?]+)/.exec(url)?.[1];
    const source = sourceId ? sourceFixture(sourceId, model) : undefined;
    if (source) return { data: source };
    throw new Error(`unexpected GET ${url}`);
  }) as typeof api.get;
}

let lastStatus = "";
function Harness() {
  lastStatus = useRuntimeFormV2(MACHINE_ID, "claude", AGENT_ID).status;
  return null;
}

beforeEach(() => {
  catalogFetches = 0;
  useServerStore.setState({ current: { id: SERVER_ID, slug: "acme", name: "Acme" } as Server });
  // The shell already fetched the catalog moments ago (inside its cache window).
  useModelLabelCatalogStore.setState({ byServer: { [SERVER_ID]: { catalog: stale, fetchedAt: Date.now() } }, inflight: {}, lastAttemptAt: {} });
});

afterEach(() => {
  cleanup();
  api.get = originalGet;
  useServerStore.setState(useServerStore.getInitialState(), true);
  useModelLabelCatalogStore.setState({ byServer: {}, inflight: {}, lastAttemptAt: {} });
});

test("a Claude form whose model list answers live reloads the shared model-label catalog", async () => {
  serve("live");
  render(<TestIntlProvider><Harness /></TestIntlProvider>);
  await waitFor(() => assert.equal(lastStatus, "ready"));
  await waitFor(() => assert.equal(catalogFetches, 1));
});

test("a Claude form whose model list fell back leaves the catalog alone, though its static sources carry no status", async () => {
  serve("fallback");
  render(<TestIntlProvider><Harness /></TestIntlProvider>);
  await waitFor(() => assert.equal(lastStatus, "ready"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(catalogFetches, 0);
});
