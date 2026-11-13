// The mounted-DOM replacement for the reachable confirmation surfaces lives in
// src/features/computer/tests/serverManagementConfirmDialog.behavior.test.tsx.
// It drives the real dialogs: Delete Server's slug-gated ConfirmDialog
// (SettingsPanel), MachineDetailPanel's single-action blocked delete, and
// ResetAgentDialog's frameless mode picker.
//
// What remains in THIS file:
// - the logout-wording catalog scan (copy is the contract), and
// - the tree-wide raw-Modal count ratchet (a per-file baseline is inherently a
//   source reading).
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { isTestPath } from "../scripts/testLocations";

const repoRoot = resolve(import.meta.dirname, "..");
// src/features holds code moved out of src/components (one folder per
// feature); the ratchet follows it there.
const scanRoots = [resolve(repoRoot, "src/components"), resolve(repoRoot, "src/features")];

function walkTsx(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = resolve(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) return walkTsx(full);
    // Feature tests (src/features/<feature>/tests/) are not app code.
    return full.endsWith(".tsx") && !isTestPath(relative(repoRoot, full)) ? [full] : [];
  });
}

test("raw Modal usage is pinned so new hand-rolled confirmations cannot slip in", () => {
  const expectedRawModalCounts: Record<string, number> = {
    // 2026-08-09, task #31: seven files LEFT this map by adopting DialogCard
    // (InviteHumanDialog, ReportIssueDialog, MachineDetailPanel, AddMembersDialog,
    // CreateChannelDialog, CreateTaskDialog, SOSDialog,
    // CreateJointChannelDialog, RolePermissionHelpDialog — ten in total; the
    // sidebar's SidebarSectionDialog followed in the Raft DS migration). Entries are deleted rather
    // than zeroed: this is a deepEqual against the real reading, so a stale entry
    // would quietly re-permit the count it used to allow. Lowering a ratchet is as
    // deliberate an act as raising one.
    // task #677: ConfirmDialog left this map by migrating its frame to the rui
    // Dialog family — confirmations are now design-system-owned end to end.
    // RuntimeConfigEditorFrame left this map by moving to DialogCard (raft-ui Dialog; focus step 2, batch 3).
    // ChannelMembers left this map when its legacy Modal shell was removed
    // (production renders it only as a panel or a page).
    // CreateAgentDialog, CommunityAgreementDialog and ConnectedAppDetailModal
    // left this map by moving to raft-ui's Dialog (focus step 2, batch 1).
    // task #187 overflow drawer: the unsaved name/description draft prompt needs
    // three actions (keep editing / discard / save and close); ordinary
    // destructive confirmations remain ConfirmDialog-owned.
    // MainLayout (the task and legacy-task dialogs) and LegacyTaskPanel (a comment naming <Modal>) left this map
    // when slock's Modal was deleted (focus step 2, batch 7): the task dialog is a raft-ui Dialog (TaskDialogShell).
    // The map is now empty and stays so: a <Modal> anywhere is a hand-rolled dialog coming back.
    // AddMachineDialog left this map by adopting DialogCard (Raft DS Dialog).
    // ForwardComposerDialog left this map and ForwardComposerDesktop entered it:
    // the desktop forward surface split out of the dialog and took the raw Modal
    // with it. ForwardComposerDesktop left it too, for raft-ui's Dialog (focus
    // step 2, batch 3).
    // ServerSetupProjectionGate left this map: its blocking setup steps are a
    // raft-ui Dialog (SetupStepDialog) since focus step 2, batch 5.
    // SearchOverlay (the desktop ⌘K search) left this map: a raft-ui Dialog with
    // placement="top" since focus step 2, batch 6.
    // Product feedback is a routed Settings subpage. Its workspace and lazy
    // loading state intentionally use panel chrome rather than raw Modal.
    // DialogCard is a raft-ui Dialog; its old Modal shell (LegacyDialogCard, for
    // a layer-2 card and the runtime editor's phone sheet) was deleted in batch 3.
    // components/ui/Lightbox.tsx (it named <Modal> in a comment) was deleted with the move of the file viewer and
    // the share preview to raft-ui's Lightbox (batch 4).
  };

  const actual: Record<string, number> = {};
  for (const file of scanRoots.flatMap((root) => walkTsx(root))) {
    const source = readFileSync(file, "utf8");
    const count = source.match(/<Modal\b/g)?.length ?? 0;
    if (count > 0) {
      actual[relative(repoRoot, file)] = count;
    }
  }

  assert.deepEqual(actual, expectedRawModalCounts);
});
