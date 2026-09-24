import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");
// Asserts on private CI/deploy files that the source-available snapshot does not
// carry; skipped when an exported snapshot's RELEASE_SOURCE marker is present.
const inSourceSnapshot = existsSync(resolve(repoRoot, "../../RELEASE_SOURCE"));

function backupSourceRoot(): string | null {
  const tmp = resolve(repoRoot, ".stryker-tmp");
  if (!existsSync(tmp)) return null;

  const backup = readdirSync(tmp).find((entry) => entry.startsWith("backup-"));
  return backup ? resolve(tmp, backup, "src") : null;
}

const readSource = (path: string) => {
  if (path.startsWith("src/")) {
    const sourcePath = path.slice("src/".length);
    const backupPath = backupSourceRoot();
    const candidate = backupPath ? resolve(backupPath, sourcePath) : null;
    return readFileSync(candidate && existsSync(candidate) ? candidate : resolve(repoRoot, "src", sourcePath), "utf8");
  }

  return readFileSync(resolve(repoRoot, path), "utf8");
};

function sourceSlice(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `missing ${start}`);

  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `missing ${end}`);

  return source.slice(startIndex, endIndex);
}

test("add computer dialog uses the shared explicit platform command selector", () => {
  const source = readSource("src/components/machine/AddMachineDialog.tsx");
  const guideSource = readSource("src/components/machine/ComputerCommandGuide.tsx");

  assert.match(source, /const serverSlug = useServerStore\(\(s\) => s\.current\?\.slug\)/);
  assert.match(source, /const deploymentEnv = import\.meta\.env\?\.VITE_DEPLOYMENT_ENV/);
  assert.match(source, /const computerCommands = getComputerCommands\(serverSlug, deploymentEnv, serverUrl, \{/);
  assert.match(source, /const windowsComputerCommands = getComputerCommands\(serverSlug, deploymentEnv, serverUrl, \{/);
  assert.match(source, /platform: "windows"/);
  assert.match(source, /legacyApiKey: apiKey/);
  assert.match(source, /computerCommands\?\.install/);
  assert.match(source, /computerCommands\?\.setup/);
  assert.match(source, /const macLinuxDaemonCommand = getDaemonConnectCommand\(\{/);
  assert.match(source, /platform: "mac-linux"/);
  assert.match(source, /const windowsDaemonCommand = getDaemonConnectCommand\(\{/);
  assert.match(source, /platform: "windows"/);
  assert.match(source, /<ComputerCommandGuide/);
  assert.match(source, /macLinuxDaemonCommand=\{macLinuxDaemonCommand\}/);
  assert.match(source, /windowsDaemonCommand=\{windowsDaemonCommand\}/);
  assert.match(source, /windowsComputerCommand=\{windowsComputerSetupCommand\}/);
  assert.match(source, /windowsComputerInstallCommand=\{windowsComputerInstall\}/);
  assert.match(guideSource, /SegmentedControl<ComputerCommandPlatform>/);
  assert.match(guideSource, /value="mac-linux"/);
  assert.match(guideSource, /value="windows"/);
  assert.match(guideSource, /id: "machine\.commandGuide\.windowsX64"/);
  assert.match(guideSource, /id: "machine\.commandGuide\.raftComputerWindowsX64"/);
  assert.match(guideSource, /id: "machine\.commandGuide\.macLinuxDaemonDescription"/);
  assert.doesNotMatch(guideSource, /Computer CLI setup is not available for this server yet/);
  assert.match(guideSource, /data-testid="windows-computer-command-block"/);
  assert.match(guideSource, /<Badge\.Experimental\s*\/>/);
  assert.match(guideSource, /function getComputerSteps\(/);
  assert.match(guideSource, /const install = platform === "windows" \? windowsInstall : macLinuxInstall/);
  assert.match(guideSource, /const setup = platform === "windows" \? windowsSetup : macLinuxSetup/);
  assert.match(guideSource, /target: `\$\{prefix\}-install`/);
  assert.match(guideSource, /target: `\$\{prefix\}-setup`/);
  assert.match(guideSource, /data-testid="windows-daemon-command-block"/);
  assert.match(guideSource, /id: "machine\.commandGuide\.daemonLegacy"/);
  assert.match(guideSource, /onClick=\{requestWindowsDaemonCommand\}/);
  assert.doesNotMatch(guideSource, /Computer for Windows is in progress|Windows support is in progress/);
  assert.doesNotMatch(guideSource, /computer-windows-interest-button|I'm interested|trackComputerWindowsInterestClick/);
  assert.doesNotMatch(source, /Keep the terminal window open|Keep this process running/);
  assert.doesNotMatch(source, /<Badge\.Experimental\b/);
});

test("machine detail connect command uses the same platform selector and keeps online recovery guide", () => {
  const source = readSource("src/components/machine/MachineDetailPanel.tsx");

  assert.match(source, /const macLinuxConnectCommand = isKeyValid/);
  assert.match(source, /platform: "mac-linux"/);
  assert.match(source, /const windowsConnectCommand = isKeyValid/);
  assert.match(source, /platform: "windows"/);
  assert.match(source, /deploymentEnv = import\.meta\.env\?\.VITE_DEPLOYMENT_ENV/);
  assert.match(source, /const computerCommands = getComputerCommands\(serverSlug, deploymentEnv, serverUrl, \{/);
  assert.match(source, /const windowsComputerCommands = getComputerCommands\(serverSlug, deploymentEnv, serverUrl, \{/);
  assert.match(source, /legacyApiKey: isKeyValid \? savedKey : null/);
  assert.match(source, /const machineComputerCommands = windowsMachine \? windowsComputerCommands : computerCommands/);
  assert.match(source, /machineComputerCommands\?\.install/);
  assert.match(source, /machineComputerCommands\?\.setup/);
  assert.match(source, /machineComputerCommands\.status/);
  assert.match(source, /machineComputerCommands\.doctor/);
  assert.match(source, /machineComputerCommands\?\.restart/);
  assert.match(source, /<ComputerCommandGuide/);
  assert.match(source, /macLinuxDaemonCommand=\{macLinuxConnectCommand\}/);
  assert.match(source, /windowsDaemonCommand=\{windowsConnectCommand\}/);
  assert.match(source, /machine\.isComputer && machine\.status !== "online"/);
  assert.match(source, /windowsMachine \? <Badge\.Experimental \/> : null/);
  assert.match(source, /data-testid="legacy-daemon-block"/);
  assert.doesNotMatch(source, /Computer for Windows is in progress/);
  assert.match(source, /id: "machine\.detail\.restartIfUnresponsive"/);
  assert.doesNotMatch(source, /service-version skew/);
  assert.match(source, /id: "machine\.detail\.copySetupCommand"/);
  assert.match(source, /\["computer-install", formatMessage\(\{ id: "machine\.detail\.installStep" \}\), computerInstall\]/);
  assert.match(source, /\["computer-setup", formatMessage\(\{ id: "machine\.detail\.setupStep" \}\), computerSetupCommand\]/);
  assert.match(source, /handleCopy\(target, command\)/);
  assert.match(source, /copiedCommand === target/);
  assert.doesNotMatch(source, /Keep this process running/);
  assert.doesNotMatch(source, /Download it here/);
});

test("Windows Computer copy stays x64-scoped to the production manifest and the manual daemon command is executable PowerShell", { skip: inSourceSnapshot && "source-available snapshot has no private CI/deploy files" }, () => {
  const guide = readSource("src/components/machine/ComputerCommandGuide.tsx");
  const detail = readSource("src/components/machine/MachineDetailPanel.tsx");
  const manual = readSource("../../manual/agent-knowledge/computer.md");
  const releaseWorkflow = readSource("../../.github/workflows/publish-computer-sea.yml");

  assert.match(guide, /id: "machine\.commandGuide\.windowsX64"/);
  assert.match(guide, /id: "machine\.commandGuide\.raftComputerWindowsX64"/);
  assert.match(detail, /id: "machine\.detail\.migrateToComputer"[\s\S]*id: "machine\.detail\.windowsX64Suffix"/);
  assert.match(detail, /platform: windowsMachine \? "windows" : "mac-linux"/);
  assert.match(detail, /\{computerFreshInstall\}/);
  assert.doesNotMatch(detail, /\{computerCommands\.install\}/);

  assert.match(manual, /\*\*Windows x64 · Experimental\*\*/);
  assert.match(
    manual,
    /npx\.cmd @botiverse\/raft-daemon@latest --server-url https:\/\/api\.raft\.build --api-key sk_machine_<hex>/,
  );
  assert.doesNotMatch(manual, /npx\.cmd[^\n]*\\\s*\n/);

  assert.match(releaseWorkflow, /--required-targets darwin-arm64,darwin-x64,linux-x64,linux-arm64,win32-x64/);
  assert.doesNotMatch(releaseWorkflow, /win32-arm64/);
});

test("machine detail computer actions expose terminal verification and the recovery ladder", () => {
  const source = readSource("src/components/machine/MachineDetailPanel.tsx");
  const englishMessages = readSource("src/i18n/messages/en.ts");

  assert.doesNotMatch(source, /COMPUTER_TERMINAL_VERIFICATION_COMMANDS/);
  assert.match(source, /data-testid="computer-terminal-verification"/);
  assert.match(source, /id: "machine\.detail\.verifyFromTerminal"/);
  assert.match(source, /id: "machine\.detail\.verifyFromTerminalDescription"/);
  assert.match(source, /id: "machine\.detail\.webButtonsNotResponding"/);
  assert.match(source, /const terminalStatusCommands = machineComputerCommands[\s\S]*machineComputerCommands\.status[\s\S]*machineComputerCommands\.doctor/);
  assert.match(source, /const terminalRestartCommand = machineComputerCommands\?\.restart/);
  assert.match(source, /terminalStatusCommands\.map/);
  assert.match(source, /handleCopy\(target, command\)/);
  assert.match(source, /handleCopy\("terminal-restart", terminalRestartCommand\)/);
  assert.match(source, /data-testid="computer-recovery-guide"/);
  assert.match(source, /aria-expanded=\{showRecoveryGuide\}/);
  assert.match(source, /const recoveryGuideContentId = `computer-recovery-guide-content-\$\{useId\(\)\}`/);
  assert.match(source, /aria-controls=\{recoveryGuideContentId\}/);
  assert.match(source, /id=\{recoveryGuideContentId\}/);
  assert.match(source, /data-testid="computer-recovery-guide-content"/);
  assert.match(source, /machine\.status !== "online"/);
  assert.match(source, /id: "machine\.detail\.restartStep"/);
  assert.match(source, /id: "machine\.detail\.freshInstallStep"/);
  assert.match(source, /machine\.computer\.recovery\.restartAfterInstallStep/);
  assert.match(englishMessages, /"machine\.computer\.recovery\.restartAfterInstallStep": "3\. Restart after install"/);
  assert.match(source, /data-testid="computer-upgrade-fresh-install"/);
  assert.match(source, /data-testid="computer-upgrade-fresh-restart"/);
  assert.match(source, /data-testid="computer-recovery-guide-restart-after-install"/);
  assert.doesNotMatch(source, /Stop, then start|terminalStopCommand|terminalStartCommand|terminal-stop|terminal-start/);
  assert.match(
    englishMessages,
    /without removing this Computer's identity or credentials/,
  );
  assert.doesNotMatch(source, /Clear state|Delete identity|Remove credentials/);
  assert.doesNotMatch(source, /--migration-details/);
  assert.doesNotMatch(source, /--server-url/);
});

test("experimental labels remain on explicit experimental features and stay off unrelated app surfaces", () => {
  assert.equal(existsSync(resolve(repoRoot, "src/components/ui/ExperimentalBadge.tsx")), false);

  const graphSource = readSource("src/components/layout/MainLayout.tsx");
  assert.match(graphSource, /from "raft-ui";/);
  assert.match(graphSource, /<Badge\.Experimental\b/);
  assert.doesNotMatch(graphSource, /ExperimentalBadge/);

  const guideSource = readSource("src/components/machine/ComputerCommandGuide.tsx");
  assert.match(guideSource, /<Badge\.Experimental\s*\/>/);
  assert.match(guideSource, /platform === "windows"/);

  const settingsSource = readSource("src/components/settings/SettingsPanel.tsx");
  assert.doesNotMatch(settingsSource, /ExperimentalBadge/, "SettingsPanel should not use the deleted adapter");
  assert.match(settingsSource, /from "raft-ui";/);
  const appNotificationsLabel = sourceSlice(
    settingsSource,
    "function AppNotificationsLabel()",
    "function AppNotificationsEditorRailLabel()",
  );
  assert.match(appNotificationsLabel, /<Badge\.Experimental\s*\/>/);
  assert.match(settingsSource, /sectionId="notifications"[\s\S]*title=\{<AppNotificationsLabel \/>}/);

  const editorRailLabel = sourceSlice(
    settingsSource,
    "function AppNotificationsEditorRailLabel()",
    "function ConnectedAppEditorSection(",
  );
  assert.doesNotMatch(editorRailLabel, /<Badge\.Experimental\b/);
  assert.match(settingsSource, /id: "notifications", label: <AppNotificationsEditorRailLabel \/>/);

  const appNotificationsControlsSource = readSource("src/components/settings/AppNotificationsControls.tsx");
  assert.doesNotMatch(appNotificationsControlsSource, /ExperimentalBadge/);
  assert.match(appNotificationsControlsSource, /from "raft-ui";/);
  const appNotificationsEyebrow = sourceSlice(
    appNotificationsControlsSource,
    "function AppNotificationsEyebrow()",
    "export function AppNotificationPermissionPicker(",
  );
  assert.match(appNotificationsEyebrow, /settings\.connectedApps\.section\.appNotifications/);
  assert.match(appNotificationsEyebrow, /<SectionEyebrow as="div">\{formatMessage/);
  assert.match(appNotificationsEyebrow, /<Badge\.Experimental\s*\/>/);

  const humanLoginSetupSource = readSource("src/pages/HumanLoginSetupPage.tsx");
  assert.doesNotMatch(humanLoginSetupSource, /<Badge\.Experimental\b/);
  assert.doesNotMatch(humanLoginSetupSource, /ExperimentalBadge/);
});
