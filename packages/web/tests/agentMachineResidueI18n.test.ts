import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");

function readSource(path: string) {
  return readFileSync(resolve(repoRoot, path), "utf8");
}

function assertContainsIds(source: string, ids: readonly string[]) {
  for (const id of ids) {
    assert.ok(source.includes(`"${id}"`), `missing ${id}`);
  }
}

function assertNoVisibleLiterals(source: string, literals: readonly string[]) {
  for (const literal of literals) {
    assert.doesNotMatch(source, new RegExp(literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
}

// SCOPE, corrected after @铁根's 7/31 patrol: this is a SOURCE-ADOPTION guard, not
// a rendering test. It spans five active components and asserts only that each id appears
// SOMEWHERE in its file and that the old English literal is gone. It therefore
// proves the strings were adopted into the catalog and not re-hardcoded — and
// nothing about which callsite uses which id. Swapping two existing ids inside
// one file keeps it green while the visible semantics are wrong.
//
// The previous name ("... renders local component copy ...") over-promised
// exactly that. Where these states are reachable, the semantic tooth belongs in a
// mounted zh behaviour test; where they are not, the upgrade is per-callsite
// pairing with a wrong-existing-id / swap mutation going RED (see
// settingsPanelCallsitePairing.test.ts for that shape).
test("agent and machine residue slice adopts FormatJS ids without re-hardcoding English", () => {
  const agentSkills = readSource("src/components/agent/AgentSkills.tsx");
  const agentWorkspace = readSource("src/components/agent/AgentWorkspace.tsx");
  const pixelAvatar = readSource("src/components/agent/PixelAvatar.tsx");
  const addMachineDialog = readSource("src/components/machine/AddMachineDialog.tsx");
  const computerCommandGuide = readSource("src/components/machine/ComputerCommandGuide.tsx");

  assertContainsIds(agentSkills, [
    "agent.skills.loadFailed",
    "agent.skills.loading",
    "agent.skills.title",
    "agent.skills.globalEmpty",
    "agent.skills.workspaceEmpty",
  ]);
  assertContainsIds(agentWorkspace, [
    "agent.workspace.copiedPath",
    "agent.workspace.hiddenFilesShown",
    "agent.workspace.filesLoadFailed",
    "agent.workspace.selectFile",
    "agent.workspace.binaryCannotDisplay",
  ]);
  assertContainsIds(pixelAvatar, ["agent.avatar.alt"]);
  assertContainsIds(addMachineDialog, [
    "machine.add.registerFailed",
    "machine.add.title.add",
    "machine.add.waitingForConnect",
    "machine.add.connectedSuccessfully",
    "machine.add.computerName",
    "machine.add.confirmComputerMatch",
  ]);
  assertContainsIds(computerCommandGuide, [
    "machine.commandGuide.connectCommand",
    "machine.commandGuide.choosePlatform",
    "machine.commandGuide.windowsX64",
    "machine.commandGuide.raftComputerWindowsX64",
    "machine.commandGuide.daemonLegacy",
    "machine.commandGuide.generateLegacyDaemonCommand",
  ]);


  assertNoVisibleLiterals(agentSkills, [
    "Failed to load skills",
    "Loading skills",
    "No global skills installed on this computer",
    "No skills in this agent's workspace",
  ]);

  assertNoVisibleLiterals(agentWorkspace, [
    "Copied path",
    "Copy path",
    "Hidden files shown",
    "Hidden files hidden",
    "Failed to load files",
    "Select a file to view",
    "Binary file",
  ]);

  assertNoVisibleLiterals(addMachineDialog, [
    "Failed to register computer",
    "Add Computer",
    "Connect Computer",
    "Computer Connected",
    "Run agents on your own computer",
    "Coming soon",
    "Waiting for computer to connect",
    "Computer connected successfully",
    "Computer Name",
    "A friendly name for this computer.",
    "My Mac",
    "This is the computer I just set up",
  ]);

  assertNoVisibleLiterals(computerCommandGuide, [
    "Connect command",
    "Choose computer setup platform",
    "Run this daemon command on this macOS or Linux machine",
    "Daemon / Legacy",
    "Show legacy daemon command",
    "Generate legacy daemon command",
  ]);
  assert.doesNotMatch(computerCommandGuide, /copyAriaLabel: `Copy /);
  assert.doesNotMatch(pixelAvatar, /alt="Agent avatar"/);
});
