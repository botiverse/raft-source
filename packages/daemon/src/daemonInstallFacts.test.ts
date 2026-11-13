import assert from "node:assert/strict";
import { test } from "vitest";
import { daemonInstallFacts, nodeOnPath } from "./daemonInstallFacts";

const sea = { execIsElectron: false, execIsSea: true };
const plainNode = { execIsElectron: false, execIsSea: false, hasNodeRuntime: true };

test("installKind follows the codex driver's host_kind and is left out when the host is unknown", () => {
  const none = { env: { PATH: "" }, platform: "linux" as const };
  assert.equal(daemonInstallFacts({ ...none, hostKind: sea }).installKind, "sea");
  assert.equal(daemonInstallFacts({ ...none, hostKind: plainNode }).installKind, "node");
  assert.equal(daemonInstallFacts({ ...none, hostKind: { execIsElectron: true } }).installKind, "electron");
  assert.equal("installKind" in daemonInstallFacts({ ...none, hostKind: { execIsElectron: false, seaProbe: () => undefined } }), false);
});

test("nodeOnPath looks for an executable node in absolute PATH entries only", () => {
  const seen: string[] = [];
  const isExecutableFile = (file: string) => { seen.push(file); return file === "/opt/node/bin/node"; };
  assert.equal(nodeOnPath({ env: { PATH: "relative/bin::/usr/bin:/opt/node/bin" }, platform: "linux", isExecutableFile }), true);
  assert.deepEqual(seen, ["/usr/bin/node", "/opt/node/bin/node"], "relative and empty entries are skipped");
  assert.equal(nodeOnPath({ env: { PATH: "/usr/bin" }, platform: "linux", isExecutableFile }), false);
  assert.equal(nodeOnPath({ env: {}, platform: "linux", isExecutableFile }), false);
});

test("nodeOnPath on Windows reads Path and looks for node.exe", () => {
  const seen: string[] = [];
  const isExecutableFile = (file: string) => { seen.push(file); return file === "C:\\Program Files\\nodejs\\node.exe"; };
  assert.equal(nodeOnPath({ env: { Path: "C:\\Windows;C:\\Program Files\\nodejs" }, platform: "win32", isExecutableFile }), true);
  assert.deepEqual(seen, ["C:\\Windows\\node.exe", "C:\\Program Files\\nodejs\\node.exe"]);
});
