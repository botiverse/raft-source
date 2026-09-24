// The mounted-DOM replacement for the reachable confirmation surfaces lives in
// tests/serverManagementConfirmDialog.behavior.test.tsx.
// It drives the real dialogs: Delete Server's slug-gated ConfirmDialog
// (SettingsPanel), MachineDetailPanel's single-action blocked delete, and
// ResetAgentDialog's frameless mode picker.
//
// What remains in THIS file is legitimately source-level:
// - the Sidebar dead-machine-menu removal assertion below: no mounted test can
//   drive an entry that has no trigger, so the product decision is pinned as
//   deliberate absence rather than a silently reintroduced branch;
// - the logout-wording catalog scan (copy is the contract), and
// - the tree-wide raw-Modal count ratchet (a per-file baseline is inherently a
//   source reading).
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import test from "node:test";
import { en as enMessages } from "../src/i18n/messages/en";

const repoRoot = resolve(import.meta.dirname, "..");
const componentRoot = resolve(repoRoot, "src/components");

function read(path: string) {
  return readFileSync(resolve(repoRoot, path), "utf8");
}

function walkTsx(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = resolve(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) return walkTsx(full);
    return full.endsWith(".tsx") ? [full] : [];
  });
}

test("Sidebar no longer carries the unreachable machine context-menu chain", () => {
  const sidebar = read("src/components/layout/Sidebar.tsx");
  const enCatalog = read("src/i18n/messages/en.ts");
  const zhCatalog = read("src/i18n/messages/zh-cn.ts");

  assert.doesNotMatch(sidebar, /ctxMenu\.type === "machine"/);
  assert.doesNotMatch(sidebar, /deleteConfirm\.type === "machine"/);
  assert.doesNotMatch(sidebar, /setDeleteConfirm\(\{ type: "machine"/);
  assert.doesNotMatch(sidebar, /createAgentForMachineId/);
  for (const [label, catalog] of [["en", enCatalog], ["zh-cn", zhCatalog]] as const) {
    assert.doesNotMatch(
      catalog,
      /layout\.sidebar\.(createAgentMenu|deleteComputerMenu|cannotDeleteComputerTitle|cannotDeleteComputerBody|deleteComputerTitle|deleteComputerMessage)/,
      `${label} catalog must not retain dead machine-menu keys`,
    );
  }
});

test("logout and signed-in identity copy stay on the canonical wording", () => {
  const app = read("src/App.tsx");
  const emailVerification = read("src/components/auth/EmailVerificationPage.tsx");
  const serverSelector = read("src/components/auth/ServerSelector.tsx");
  const settings = read("src/components/settings/SettingsPanel.tsx");

  for (const [label, source] of Object.entries({ app, emailVerification, serverSelector, settings })) {
    assert.doesNotMatch(source, /Sign out|Sign Out|Signing out|Signing Out/, `${label} must use Log out wording`);
  }

  // The source greps above are no longer sufficient on their own. As these
  // surfaces migrate to react-intl the wording moves OUT of the component and
  // into the catalog, where this test never looked — `settings.session.*` could
  // be retranslated to "Sign out" and every check above would still pass.
  //
  // EmailVerificationPage migrated first (pages.emailVerification.*), so the rule
  // is enforced on the catalog too, for every id whose English mentions logging
  // out. Scanning by VALUE rather than by a fixed id list means ids minted later
  // are covered without anyone remembering to add them here.
  const enCatalog = enMessages as Record<string, string>;
  const logoutIds = Object.keys(enCatalog).filter((id) =>
    /log ?out|sign ?out/i.test(enCatalog[id]),
  );
  assert.ok(logoutIds.length > 0, "expected some logout copy in the catalog");
  for (const id of logoutIds) {
    assert.doesNotMatch(
      enCatalog[id],
      /Sign out|Sign Out|Signing out|Signing Out/,
      `${id} must use "Log out" wording, not "Sign out"`,
    );
  }

  assert.match(serverSelector, /import SignedInAs from "\.\/SignedInAs";/);
  // The `nameClassName="font-bold text-black/70" suffix=". "` variant this used
  // to pin lived inside ServerSelector's `{isFirstServer && user && …}` block —
  // unreachable, since that code sits after the isFirstServer branch returns.
  // The block was removed (@AngLee signed off on deleting its copy), so this
  // assertion is dropped rather than re-anchored: it was guarding the shape of
  // code that could never render. `OnboardingCreateShell` renders the real
  // first-server footer with a DIFFERENT variant (`nameClassName="font-normal"`),
  // so nothing here loses coverage.
  assert.match(serverSelector, /<SignedInAs user=\{user\} \/>/);
});

test("raw Modal usage is pinned so new hand-rolled confirmations cannot slip in", () => {
  const expectedRawModalCounts: Record<string, number> = {
    // 2026-08-09, task #31: seven files LEFT this map by adopting DialogCard
    // (InviteHumanDialog, ReportIssueDialog, MachineDetailPanel, AddMembersDialog,
    // CreateChannelDialog, CreateTaskDialog, WikiPanel, SOSDialog,
    // CreateJointChannelDialog, RolePermissionHelpDialog — ten in total). Entries are deleted rather
    // than zeroed: this is a deepEqual against the real reading, so a stale entry
    // would quietly re-permit the count it used to allow. Lowering a ratchet is as
    // deliberate an act as raising one.
    "src/components/AnnouncementModal.tsx": 1,
    "src/components/ConfirmDialog.tsx": 1,
    "src/components/agent/AgentDetailPanel.tsx": 2,
    "src/components/agent/ChannelMembers.tsx": 2,
    // Flag-off compatibility keeps the pre-overflow member modal isolated so
    // disabling the rollout really returns to the old surface.
    "src/components/agent/LegacyChannelMembers.tsx": 2,
    "src/components/agent/CreateAgentDialog.tsx": 3,
    // task #187 overflow drawer: the unsaved name/description draft prompt needs
    // three actions (keep editing / discard / save and close); ordinary
    // destructive confirmations remain ConfirmDialog-owned.
    "src/components/channel/ChannelOverflowMenu.tsx": 1,
    // 5, not 4, since #4799 (embedded-WebView settings). Verified before bumping: none of
    // MainLayout's Modals is a confirmation — they wrap the thread panel, the legacy task
    // panel and workspace settings. The guard's PURPOSE (no hand-rolled confirmations) is
    // intact; only its count drifted.
    //
    // Worth noting how this broke. #4799 added the Modal at 17:43 and #4766 added this
    // baseline at 17:45, computed before #4799 landed. Both PRs were green alone and red
    // together, and staging has been red for everyone since — the same shape as tonight's
    // migration-number collisions. A baseline is a READING, and a reading can go stale while
    // you are looking away.
    "src/components/layout/MainLayout.tsx": 5,
    "src/components/layout/SidebarSectionDialog.tsx": 1,
    "src/components/machine/AddMachineDialog.tsx": 1,
    // ForwardComposerDialog left this map and ForwardComposerDesktop entered it:
    // the desktop forward surface split out of the dialog and took the raw Modal
    // with it. One entry out, one in — not a ratchet change, a rename of where
    // the same single Modal lives.
    "src/components/message/ForwardComposerDesktop.tsx": 1,
    // The four mandatory setup steps in the browser flow (computer_runtime,
    // create_agent, survey, handoff) render as gate-owned Modals; the client
    // standalone page renders the same steps as page content instead.
    "src/components/onboarding/ServerSetupProjectionGate.tsx": 4,
    "src/components/server/CommunityAgreementDialog.tsx": 1,
    // Product feedback is a routed Settings subpage. Its workspace and lazy
    // loading state intentionally use panel chrome rather than raw Modal.
    // Connected Apps adds one installed-app detail Modal. It contains read-only
    // state and ordinary commands; destructive uninstall remains ConfirmDialog-owned.
    "src/components/settings/SettingsPanel.tsx": 4,
    // Ordinary Create Agent and Add/Edit MCP forms share this product dialog shell.
    "src/components/ui/DialogCard.tsx": 1,
    "src/components/task/LegacyTaskPanel.tsx": 1,
    "src/components/ui/Lightbox.tsx": 1,
  };

  const actual: Record<string, number> = {};
  for (const file of walkTsx(componentRoot)) {
    const source = readFileSync(file, "utf8");
    const count = source.match(/<Modal\b/g)?.length ?? 0;
    if (count > 0) {
      actual[relative(repoRoot, file)] = count;
    }
  }

  assert.deepEqual(actual, expectedRawModalCounts);
});
