// DOM nodes never go to node:assert as values (tests/assertionNullCompareGuard.test.ts).
// The Computer page's Detected runtimes name each runtime by its plain name:
// the catalog's experimental flag is not shown anywhere (cindyz, #triage:#524),
// whether the server answers it or the bundle does.
import assert from "node:assert/strict";
import "./helpers/domSetup";
import { cleanup, render, screen } from "@testing-library/react";
import { RUNTIMES, SERVER_RUNTIME_CATALOG_VERSION } from "@botiverse/raft-shared";
import type { ServerRuntimeCatalog } from "@botiverse/raft-shared";

import { TestIntlProvider } from "./helpers/intl";
import MachineRuntimeChips from "../src/components/machine/MachineRuntimeChips";
import { resetServerRuntimeCatalogReadsForTests } from "../src/hooks/useServerRuntimeCatalog";
import { sharedCatalogReads } from "../src/store/serverRuntimeCatalogCache";
import { RuntimeAuthClient } from "../src/utils/runtimeAuthClient";

afterEach(() => {
  cleanup();
  resetServerRuntimeCatalogReadsForTests();
});

function serverCatalog(overrides: Record<string, { deprecated?: boolean; experimental?: boolean }>): ServerRuntimeCatalog {
  return {
    catalogVersion: SERVER_RUNTIME_CATALOG_VERSION,
    runtimes: RUNTIMES.map((runtime) => ({
      id: runtime.id,
      displayName: runtime.displayName,
      abbreviation: runtime.abbreviation,
      binary: runtime.binary,
      supported: runtime.supported,
      deprecated: overrides[runtime.id]?.deprecated ?? Boolean(runtime.deprecated),
      experimental: overrides[runtime.id]?.experimental ?? Boolean(runtime.experimental),
      oarOnly: false,
      models: [],
      modelsSource: "fallback",
      forms: [{ kind: "generic" }],
    })),
  };
}

/** The server's answer, already read (as a row mounting after the shared read sees it). */
function serverAnswers(catalog: ServerRuntimeCatalog | null) {
  sharedCatalogReads.set("s1", { promise: Promise.resolve(catalog), settledAt: Date.now(), catalog });
}

const noAuthReads = new RuntimeAuthClient(
  { get: async () => assert.fail("no runtime-auth read"), post: async () => assert.fail("no runtime-auth write") },
  { current: () => null, onReplaced: () => () => {} },
);

function chips(machineRuntimeIds: string[]) {
  render(
    <TestIntlProvider>
      <MachineRuntimeChips machineId="m1" machineRuntimeIds={machineRuntimeIds} serverId="s1" canViewRuntimeAccountUsage={false} runtimeAuthClient={noAuthReads} />
    </TestIntlProvider>,
  );
}

test("an experimental runtime's chip is its plain name, as the server answers it", () => {
  serverAnswers(serverCatalog({ claude: { experimental: true } }));
  chips(["claude", "qwen", "qoder", "antigravity"]);
  for (const name of ["Claude Code", "Qwen Code", "Qoder", "Antigravity CLI"]) {
    assert.ok(screen.queryByText(name) !== null, `${name} is its plain name`);
  }
  assert.ok(screen.queryByText(/experimental/i) === null, "no Experimental label");
});

test("a server too old to serve its catalog: still the plain names", () => {
  serverAnswers(null);
  chips(["claude", "qwen", "antigravity"]);
  assert.ok(screen.queryByText("Qwen Code") !== null);
  assert.ok(screen.queryByText("Antigravity CLI") !== null);
  assert.ok(screen.queryByText(/experimental/i) === null);
});
