import assert from "node:assert/strict";
import { parse, TYPE } from "@formatjs/icu-messageformat-parser";
import type { MessageFormatElement } from "@formatjs/icu-messageformat-parser";

import { en } from "../src/i18n/messages/en";

// The file keeps its old name because CI's "Clickable label Title Case guard
// (web)" step runs it by path, and .github/workflows/ is a person's to change;
// renaming it to clickableLabelSentenceCase.test.ts is a follow-up.

/**
 * Raft Design System, content/writing.md "Casing" (stdrc, 2026-11-05,
 * #proj-raft-ui:10ce032d; replaces the Title Case rule of 2026-05-26):
 *
 *   - Anything a person can click or that names an action (buttons, menu items,
 *     tabs, segmented controls, text links, the tooltip and aria-label of an
 *     icon button, a dialog title that repeats its button) is sentence case:
 *     Create task, Mark all as read, Convert to task.
 *   - Only the first word is capitalized. A later word keeps its capital only
 *     for a proper, brand or product name (Raft, Raft Computer, Slack, Pro…), a
 *     feature, destination or view name registered in raft-design's
 *     design/content/terminology.md (Agent Lounge, Home, Activity, Saved,
 *     Active, Settings, Members, Tasks, Computers, Artifact), a task status
 *     (Mark as Done, Reopen to Todo), a key name (Enter, Esc) or an acronym (AI,
 *     MCP, URL). Everything else is lowercase: Invite members, Visible to
 *     guests, Create joint channel, Browse marketplace, Mark as unread.
 *   - A multi-word status, section or page name is itself sentence case: In
 *     progress, Direct messages, Joint channels, Plan & billing.
 *
 * CLICKABLE_LABEL_IDS is the audited list of en message ids whose text renders
 * as the visible label of a clickable control (children of <Button>, <button>,
 * MenuItem / DropdownMenuItem / ContextMenuItem, SegmentedControl labels,
 * confirm/submit labels, toast actions, standalone text links); each must be
 * sentence case. The catalog-wide test below also fails on any short en value
 * written in Title Case (every later word capitalized), which is how tooltips,
 * aria-labels and dialog titles are covered without listing each one.
 *
 * Adding a clickable label? Add its id here so the casing is pinned.
 */

// Words that keep their capital after the first word. Each group is a reason;
// keep it to words the catalog actually uses. Acronyms and own-casing names
// (AI, MCP, GitHub, macOS, iOS), single letters and words with digits are
// allowed without being listed.
const NAMES = new Set([
  // Product, brand and platform names (the rule's list, and those labels use)
  "Raft", "Stamp", "Porthole", "Slack", "Google", "Apple", "Claude", "Codex", "Pi", "Markdown",
  "Stripe", "Alipay", "Android", "Windows", "Mac", "Linux", "Intel", "Chinese", "Cindy",
  // Plans
  "Pro", "Free",
  // Feature, destination and view names registered in raft-design's
  // design/content/terminology.md (Agent Lounge and Raft Computer are PHRASES)
  "Home", "Activity", "Saved", "Active", "Settings", "Members", "Tasks", "Computers", "Artifact", "Artifacts",
  // An agent's Lounge is the Agent Lounge feature: "{name}'s Lounge"
  "Lounge",
  // Task statuses
  "Backlog", "Todo", "Done", "Closed",
  // Key names
  "Enter", "Esc", "Shift", "Tab", "Ctrl", "Alt",
]);

// Multi-word names: every word keeps its capital (Agent Lounge, Raft Desktop, Home Screen…).
const PHRASES = [
  "Agent Lounge", "Raft Computer", "Raft Desktop", "Claude Code", "Kimi Code", "Google Play", "App Store", "Google Cloud",
  "Home Screen", "Boring Gray", "Raft Yellow", "Microsoft Entra", "Slock Manual", "System Settings",
  "AppSumo Lifetime Pro",
  // Key names, as the keyboard shortcuts panel spells them
  "Up Arrow", "Down Arrow", "Left Arrow", "Right Arrow", "Left Bracket", "Right Bracket", "Single Quote",
].map((phrase) => phrase.split(" "));

// A word after one of these starts a new segment and may be capitalized: Task #3 · Legacy.
const SEGMENT_MARKS = new Set(["·", "—", "–", "→", "›", "|", "•"]);

// Placeholder marker for {arguments}: a word holding one is not checked.
const PLACEHOLDER = "\u0000";

/** Every rendering of an ICU message as plain text, one per plural/select branch combination. */
function expandMessage(elements: MessageFormatElement[]): string[] {
  let variants = [""];
  const append = (options: string[]) => {
    variants = variants.flatMap((prefix) => options.map((option) => prefix + option));
  };
  for (const element of elements) {
    switch (element.type) {
      case TYPE.literal:
        append([element.value]);
        break;
      case TYPE.plural:
      case TYPE.select:
        append(Object.values(element.options).flatMap((option) => expandMessage(option.value)));
        break;
      case TYPE.tag:
        append(expandMessage(element.children));
        break;
      default:
        // argument, number, date, time, pound (#): a value the label does not author.
        append([PLACEHOLDER]);
    }
  }
  return variants;
}

// Short words Title Case left lowercase; they say nothing about which casing a label uses.
const SHORT_WORDS = new Set(["a", "an", "the", "to", "in", "on", "of", "for", "as", "and", "or", "with", "from", "by", "at"]);

type Word = { core: string; opens: boolean; checked: boolean };

/** The words of one rendering; `opens` marks the first word of the label or of a segment. */
function wordsOf(text: string): Word[] {
  const out: Word[] = [];
  let opens = true;
  for (const raw of text.split(/\s+/).filter(Boolean)) {
    const core = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
    if (!core) {
      // Punctuation on its own ("/", "&", "+", "·"): only a segment mark opens a new segment.
      if (SEGMENT_MARKS.has(raw) || /[.!?:]$/.test(raw)) opens = true;
      continue;
    }
    // #channel, @mention and {placeholder} words are not authored here.
    out.push({ core, opens, checked: !raw.includes(PLACEHOLDER) && !/^[#@]/.test(raw) });
    opens = /[.!?:]$/.test(raw) && !raw.endsWith("…");
  }
  return out;
}

/** Later words that are capitalized but are not a name, an acronym or a key. */
function capitalizedLaterWords(text: string): { capitals: string[]; lowercase: number } {
  const words = wordsOf(text);
  const bare = words.map((word) => word.core.replace(/[’']s$/u, ""));
  const named = new Set<number>();
  words.forEach((_, index) => {
    for (const phrase of PHRASES) {
      if (phrase.every((part, offset) => bare[index + offset] === part)) {
        phrase.forEach((_, offset) => named.add(index + offset));
      }
    }
  });
  const capitals: string[] = [];
  let lowercase = 0;
  words.forEach((word, index) => {
    if (!word.checked) return;
    word.core.split("-").forEach((part, partIndex) => {
      if (word.opens && partIndex === 0) return;
      // Single letters (X, A-Z), digits (x64, v2) and internal capitals (GitHub, iOS, MCP).
      if (part.length < 2 || /\p{N}/u.test(part) || /\p{Lu}/u.test(part.slice(1))) return;
      const first = part[0];
      if (first.toLocaleLowerCase() === first.toLocaleUpperCase()) return;
      if (first === first.toLocaleLowerCase()) {
        if (!SHORT_WORDS.has(part)) lowercase += 1;
        return;
      }
      if (named.has(index) || NAMES.has(part) || NAMES.has(bare[index])) return;
      capitals.push(part);
    });
  });
  return { capitals, lowercase };
}

/** True when every rendering of the (ICU) label is sentence case per the Raft rule. */
function isSentenceCase(label: string): boolean {
  return expandMessage(parse(label)).every((text) => capitalizedLaterWords(text).capitals.length === 0);
}

/** True when some rendering is Title Case: every later word capitalized, one of them not a name. */
function isTitleCased(label: string): boolean {
  return expandMessage(parse(label)).some((text) => {
    const { capitals, lowercase } = capitalizedLaterWords(text);
    return capitals.length > 0 && lowercase === 0;
  });
}

const CLICKABLE_LABEL_IDS = [
  "avatar.edit.upload",
  "avatar.edit.build",
  "avatar.builder.shuffle",
  "avatar.builder.save",
  "avatar.builder.tab.background",
  "avatar.builder.tab.skin",
  "avatar.builder.tab.hair",
  "avatar.builder.tab.expression",
  "avatar.builder.tab.accessories",
  "settings.contextViewGrants.grant",
  "settings.contextViewGrants.grantConfirm",
  "accountDeletion.action",
  "accountDeletion.signInAgainButton",
  "accountDeletion.transferConfirm",
  "addSeats.promoAdd",
  "addSeats.promoApply",
  "addSeats.promoRemove",
  "artifacts.narrow.conversationConfirm",
  "artifacts.narrow.serverConfirm",
  "artifacts.widen.publicConfirm",
  "agent.apps.revokeConfirmLabel",
  "agent.mcpApps.revokeUndo",
  // Agent Lounge v0: the profile menu's Lounge item (also the sidebar row's label).
  "agent.lounge.label",
  "machine.detail.upgradeConfirm",
  "artifacts.review.discardConfirm",
  // #proj-workspace:#148: the comment box's Save Draft (beside Send); the drafts bar's Pick Element
  // and Send N (also the pending review's).
  "artifacts.review.saveDraft",
  "artifacts.review.pickElement",
  "artifacts.review.sendDrafts",
  // Comments phase 1 PR 2: the Comment button's ▾ item, and C's Back as a text button.
  "artifacts.comments.showAll",
  "artifacts.review.back",
  // #proj-workspace:#146: a comment image's failed upload cover, the button that uploads it again.
  "artifacts.comments.images.retry",
  // #proj-workspace:#101: the public page header ⋯ menu items (Copy for AI, Open in ChatGPT, Open in Claude).
  "artifacts.public.copyForAi",
  "artifacts.public.openInChatGpt",
  "artifacts.public.openInClaude",
  // #proj-workspace:#140: Fork in Raft, a header button on another server's public Artifact (⋯'s first item where the header is compact).
  "artifacts.fork.inRaft",
  // #proj-workspace:#239: ⋯'s Files and Download all, and the Files panel's Download file.
  "artifacts.menu.files",
  "artifacts.menu.downloadAll",
  "artifacts.files.downloadTooltip",
  // #proj-workspace:#244: the rest of ⋯ (an item about the Artifact names it no more: Rename, Download,
  // Delete; raft-design #1090), and the red confirmations that keep their object (Delete Artifact,
  // Delete comment, Delete draft).
  "artifacts.menu.copyLink",
  "artifacts.menu.sendToConversation",
  "artifacts.menu.visibility",
  "artifacts.menu.follow",
  "artifacts.menu.unfollow",
  "artifacts.menu.versionHistory",
  "artifacts.menu.rename",
  "artifacts.menu.download",
  "artifacts.menu.deleteAsk",
  "artifacts.menu.delete",
  "artifacts.comments.deleteConfirm",
  "artifacts.review.deleteDraftConfirm",
  "artifacts.public.signUpOrLogIn",
  // #proj-workspace:#243: the Comment button's ▾ (or ⋯) item Doesn't display well here.
  "artifacts.menu.displayReport",
  // The Artifacts page: its buttons (Kirby, #proj-workspace:#115), and the filter bar's toggle and sort (#210).
  "artifacts.dashboard.relevant",
  "artifacts.dashboard.seeAll",
  "artifacts.dashboard.sort.opened",
  "artifacts.dashboard.sort.updated",
  "artifacts.dashboard.showMore",
  "artifacts.dashboard.clearFilters",
  "artifacts.dashboard.all.clearSearch",
  "artifacts.dashboard.all.clearAll",
  "desktopAppLink.banner.open",
  "desktopAppLink.banner.stay",
  "inAppBrowserGuide.continueHere",
  "inAppBrowserGuide.continueInWeChat",
  "inAppBrowserGuide.copyLink",
  "keyboardShortcuts.edit.cancel",
  "keyboardShortcuts.edit.replace",
  "keyboardShortcuts.edit.reset",
  "keyboardShortcuts.edit.resetAll",
  "keyboardShortcuts.edit.resetAllConfirm",
  "keyboardShortcuts.edit.swap",
  "keyboardShortcuts.messageBox.changeInSettings",
  "keyboardShortcuts.settings.customize",
  "messageLink.unavailable.back",
  "messageLink.unavailable.join",
  "openInApp.bar.open",
  "openInApp.missing.download",
  "openInApp.missing.stay",
  "actionCard.reloadToRun.button",
  "actionCard.mcp.impactConfirm",
  "actionCard.feedbackType.idea",
  "actionCard.feedbackType.problem",
  "actionCard.feedback.submit",
  "actionCard.result.feedbackSubmitted",
  "actionCard.verb.submitFeedback",
  "actionCard.installDialog.confirm",
  "actionCard.installDialog.retry",
  "activity.overview.appEvents.more",
  "activity.overview.empty.openComputer",
  "activity.overview.empty.showRaw",
  "activity.overview.loadMore",
  "activity.overview.sent.more",
  "activity.overview.view.raw",
  "agent.apps.allApps",
  "appPromptText.approveTextUpdate",
  "appPromptText.confirmText",
  "appPromptText.rejectTextUpdate",
  "appPromptText.rejectConfirm",
  "agent.apps.grantAccess",
  "agent.apps.grantConfirm",
  "agent.apps.loadMore",
  "agent.archive.action.deleteWorkspace",
  "agent.archive.confirm",
  "agent.detail.moveToAnotherComputer",
  "agent.channelMembers.addMember",
  "agent.channelMembers.confirmAdd",
  "agent.channelMembers.removeAction",
  "agent.create.connectComputer",
  "agent.create.createCindy",
  "agent.create.finishSetup",
  "agent.create.hostedModel.reload",
  "agent.create.setupMyself",
  "agent.create.startOver",
  "agent.create.viewPlans",
  "agent.detail.connections.connectNew",
  "agent.detail.connections.continue",
  "agent.detail.connections.copyDetails",
  "agent.detail.connections.detach",
  "agent.detail.connections.detachConfirm",
  "agent.detail.connections.disconnectConnector",
  "agent.detail.connections.reconnect",
  "agent.detail.connections.undo",
  "agent.detail.copyDiagnosticInfo",
  "agent.detail.copySetup",
  "agent.detail.copyStep",
  "agent.detail.deleteAgent",
  "agent.detail.diagnosticInfoCopied",
  "agent.detail.externalTokenConfirmRevoke",
  "agent.detail.externalTokenCopy",
  "agent.detail.externalTokenGenerate",
  "agent.detail.externalTokenRefresh",
  "agent.detail.externalTokenRevoke",
  "agent.detail.hostedRuntime.retryWithModel",
  "agent.detail.resetRuntimeSession",
  "agent.detail.restartAgent",
  "agent.detail.restartNow",
  "agent.detail.restartReset",
  "agent.detail.saveRuntimeChange",
  "agent.detail.saveRuntimeConfig",
  "agent.detail.showAllChannels",
  "agent.detail.showFewer",
  "agent.detail.startAgent",
  "agent.detail.startMigration",
  "agent.detail.stopAgent",
  "agent.detail.stopAgentConfirm",
  "agent.detail.stopTurn",
  "agent.detail.tryMigrationAgain",
  "agent.detail.updateIdentity",
  "agent.detail.updateIdentityAndRole",
  "agent.detail.updateOfficialIdentity",
  "agent.detail.viewLogs",
  "agent.detail.viewService",
  "agent.externalCard.createCredential",
  "agent.externalCard.createNewCredential",
  "agent.externalCard.howItConnects",
  "agent.externalCard.revoke",
  "agent.externalSetup.otherAgents",
  "agent.hostedCindy.failed.connectComputer",
  "agent.mcp.addServer",
  "agent.migration.cancelAction",
  "agent.migration.moveConfirm",
  "agent.migration.cancelDialogConfirm",
  "agent.migration.cancelDialogKeepAction",
  "agent.migration.error.openComputerSettings",
  "agent.migration.error.openComputers",
  "agent.migration.error.tryAgain",
  "agent.migration.hosted.confirm",
  "agent.migration.hosted.start",
  "agent.migration.hosted.startEntry",
  "agent.reportIssue.copyReference",
  "agent.reportIssue.retryTicket",
  "agent.reportIssue.title",
  "agent.reportIssue.submit",
  "agent.reportIssue.viewTicket",
  "agent.runtimeConfig.addVariable",
  "agent.status.openComputer",
  // Not artifacts.viewer.origin ("From a message in #general"): a descriptive link, sentence case (writing.md, 2026-10-29).
  "app.update.continueAnyway",
  "app.update.refreshNow",
  "app.update.updateButton",
  "appSetup.continue",
  "appSetup.manage",
  "appSetup.refresh",
  "assistant.create.submit",
  "assistant.instructions.save",
  "assistant.pause.action",
  "assistant.pause.confirm",
  "assistant.receipt.cancel",
  "assistant.receipt.confirmRetract",
  "assistant.receipt.open",
  "assistant.receipt.retract",
  "assistant.settings.delete",
  "assistant.settings.done",
  "assistant.settings.instructions",
  "assistant.settings.permissions",
  "auth.accountLink.cancel",
  "auth.accountLink.submit",
  "auth.backToSignIn.button",
  "auth.backToSignIn.link",
  "auth.desktopSignIn.cancelWaiting",
  "auth.openInBrowser.backToOptions",
  "auth.openInBrowser.copyLink",
  "auth.openInBrowser.openBrowser",
  // The sign-in's second step and passkey sign-in (#triage:#135).
  "auth.passkey.signIn",
  "auth.secondFactor.passkeyButton",
  "auth.secondFactor.useBackupCode",
  "auth.secondFactor.usePasskey",
  "auth.secondFactor.useTotp",
  "auth.secondFactor.verify",
  // Resetting two-step verification by email (#triage:#135, design group d).
  "auth.secondFactor.cantVerify",
  "auth.recovery.back",
  "auth.recovery.cancelReset",
  "auth.recovery.finish",
  "auth.recovery.goToRaft",
  "auth.recovery.resetByEmail",
  "auth.recovery.setPassword",
  "auth.recovery.startReset",
  "auth.social.continueWith",
  "billing.upgradeToPro",
  "prepaidPro.payWithAlipay",
  "prepaidPro.preferAlipay",
  "prepaidPro.payByCardInstead",
  "prepaidSeats.commit",
  "prepaidSeats.commitNoPrice",
  "prepaidSeats.reopen",
  "prepaidSeats.priceAgain",
  "billing.keepSubscription",
  "channel.addMembers.createAgent",
  "channel.addMembers.createAgentNamed",
  "channel.addMembers.retryJoin",
  "channel.addMembers.submit",
  "channel.create.changeName",
  "channel.create.title",
  "channel.create.submit",
  "channel.create.external",
  "channel.create.externalSubmit",
  "channel.create.externalSkip",
  "channel.create.upgradeForMore",
  "channel.createJoint.addServer",
  "channel.createJoint.title",
  "channel.createJoint.viewBilling",
  "channel.edit.archiveAction",
  "channel.edit.archiveChannel",
  "channel.edit.cancelConversion",
  "channel.edit.cancelUpload",
  "channel.edit.checkConversionStatus",
  "channel.edit.confirmPrivateAction",
  "channel.edit.confirmPublicAction",
  "channel.edit.confirmHideAllAction",
  "channel.edit.confirmRestoreAllAction",
  "channel.edit.continueUpload",
  "channel.edit.convertAction",
  "channel.edit.deleteAction",
  "channel.edit.deleteChannel",
  "channel.edit.disconnectAction",
  "channel.edit.disconnectServerAction",
  "channel.edit.disconnectChannel",
  "channel.edit.leaveAction",
  "channel.edit.leaveChannel",
  "channel.edit.leaveDeleteAction",
  "channel.edit.makePrivate",
  "channel.edit.makePublic",
  "channel.edit.resendInvite",
  "channel.edit.returnToChannel",
  "channel.edit.sendInvite",
  "channel.edit.unarchiveChannel",
  "channel.externalInvite.dialog.back",
  "channel.externalInvite.dialog.commit",
  "channel.externalInvite.dialog.next",
  "channel.externalInvite.retry",
  "channel.externalInvite.title",
  "channel.externalInvite.upgrade",
  "channel.externalInvite.withdrawConfirm.confirm",
  "externalInvite.signOut",
  "externalInvite.upgrade",
  "externalInvite.back",
  "externalInvite.retry",
  "externalInvite.switchAccount",
  "externalInvite.openServer",
  "externalInvite.guest.commit",
  "externalInvite.connect.commitUnpicked",
  "externalInvite.connect.commit",
  "externalInvite.connect.commitMany",
  "externalInvite.connect.continue",
  "externalInvite.approval.commit",
  "externalInvite.approval.commitMixed",
  "externalInvite.newServer.commit",
  "externalInvite.waiting.cancel",
  "externalInvite.cancelConfirm.keep",
  "serverConnectRequest.approve",
  "serverConnectRequest.upgradeAndApprove",
  "serverConnectRequest.decline",
  "channel.memberConnect.row.askOwner",
  "common.announcement.gotIt",
  "common.lightbox.comments",
  "common.lightbox.copy",
  "common.lightbox.download",
  "common.lightbox.hideComments",
  "common.lightbox.moreActions",
  "computerHost.addDialog.continueInBackground",
  "computerHost.thisDevice.installAnother",
  "computerHost.addDialog.openThisDevice",
  "computerHost.restart",
  "computerHost.start",
  "computerHost.stop",
  // This device's buttons.
  "computerHost.thisDevice.openLogs",
  "computerHost.thisDevice.tryAgain",
  "computerHost.thisDevice.updateNow",
  "computerHost.thisDevice.update",
  "computerHost.thisDevice.addToServer",
  "computerHost.thisDevice.technicalDetails",
  "computerHost.thisDevice.stop.whenFinished",
  "computerHost.thisDevice.stop.now",
  "computerHost.thisDevice.stop.cancelWaiting",
  "computerHost.thisDevice.servers.open",
  "computerHost.thisDevice.servers.disconnect",
  "computerHost.thisDevice.disconnect.confirm",
  "computerHost.thisDevice.troubleshoot.openComputerLogs",
  "computerHost.thisDevice.troubleshoot.openDesktopLogs",
  "computerHost.thisDevice.troubleshoot.runDiagnostics",
  "computerHost.thisDevice.troubleshoot.cleanUp",
  "computerHost.thisDevice.detail.disconnect",
  "desktop.history.menu",
  "desktop.update.action",
  "desktop.update.downloadInstallerButton",
  "desktop.update.restartButton",
  "desktop.update.retryButton",
  "desktop.update.retryShortButton",
  "desktop.update.whatsNewAction",
  "devTools.overlay.hideUntilReload",
  "devTools.overlay.reload",
  "devTools.overlay.serverPicker",
  "errorBoundary.reloadApp",
  "feedback.native.diagnostics.edit",
  "feedback.native.diagnostics.omit",
  "feedback.native.diagnostics.retry",
  "feedback.native.diagnostics.skip",
  "handoff.wizard.chooseAnother",
  "handoff.wizard.confirm",
  "handoff.wizard.retryBriefing",
  "layout.leftRail.helpChineseCommunity",
  "layout.leftRail.helpCommunity",
  "layout.leftRail.helpDocumentation",
  "layout.leftRail.helpKeyboardShortcuts",
  "layout.leftRail.helpGetApp",
  "layout.leftRail.tabAssistant",
  "layout.main.guestNoChannelSettings",
  "layout.onboarding.letsGo",
  "layout.onboarding.resumeSetup",
  "layout.onboarding.serverSettings",
  "layout.onboarding.startOverConfirm",
  "layout.onboarding.switchServer",
  "layout.sidebar.archiveChannelTitle",
  "layout.sidebar.archiveChannelConfirm",
  "layout.sidebar.assistant",
  "layout.sidebar.closeChat",
  "layout.sidebar.createAgent",
  "layout.sidebar.createChannel",
  "layout.sidebar.createExternalAgent",
  "layout.sidebar.createExternalChannel",
  "layout.sidebar.createJointChannel",
  "layout.sidebar.createSection",
  "layout.sidebar.deleteChannelTitle",
  "layout.sidebar.deleteSection",
  "layout.sidebar.handoffSession",
  "layout.sidebar.hideEmptySections",
  "layout.sidebar.inviteHuman",
  "layout.sidebar.markAllAsRead",
  "layout.sidebar.markAsRead",
  "layout.sidebar.markAsUnread",
  "layout.sidebar.moveToSection",
  "layout.sidebar.newSectionMenu",
  "layout.sidebar.removeFromSection",
  "layout.sidebar.renameSection",
  "layout.sidebar.showJoinedChannelsOnly",
  "layout.systemNotifications.feedbackRepliesView",
  "layout.systemNotifications.seatJoinAddSeats",
  "layout.systemNotifications.seatJoinAskOwner",
  "machine.add.upgradeForMore",
  "machine.add.yourComputer",
  "machine.commandGuide.windowsX64",
  "machine.detail.bulkModel.apply",
  "machine.detail.bulkModel.button",
  "machine.detail.bulkModel.restartNow",
  "machine.detail.bulkModel.tryAgain",
  "machine.detail.clearAll",
  "machine.detail.create",
  "machine.detail.deleteComputer",
  "machine.detail.deleteWorkspaceTitle",
  "machine.detail.restartReset",
  "machine.detail.runtimeDetection.rescan",
  "machine.detail.selectAll",
  "machine.detail.stopAgentsTitle",
  "machine.detail.stopAgentsConfirm",
  "machine.mobile.addComputer",
  "machine.owner.dialog.publicConfirm",
  "machine.owner.dialog.transferConfirm",
  "machine.owner.makeMineButton",
  "machine.owner.transferButton",
  "machine.rack.filter.clearAll",
  "machine.rack.filter.runtime",
  "machine.rack.filter.runtime.other",
  "machine.rack.filter.status.all",
  "machine.rack.filter.status.attention",
  "machine.rack.filter.status.offline",
  "machine.rack.filter.status.online",
  "machine.rack.group.button",
  "machine.rack.group.label",
  "machine.rack.group.none",
  "machine.rack.group.other",
  "machine.rack.group.personal",
  "machine.rack.group.prefix",
  "machine.rack.group.provider",
  "machine.rack.sort.disk",
  "machine.rack.sort.label",
  "machine.rack.sort.memory",
  "machine.rack.sort.name",
  "machine.rack.sort.nameAsc",
  "machine.rack.sort.nameDesc",
  "machine.rack.sort.remaining",
  "machine.rack.sort.remainingAsc",
  "machine.rack.sort.remainingDesc",
  "machine.rack.sort.usedAsc",
  "machine.rack.sort.usedDesc",
  "machine.runtimeAuth.pi.addProvider",
  "machine.runtimeAuth.pi.removeKey.confirm",
  "machine.runtimeAuth.provider.back",
  "machine.runtimeAuth.provider.connect",
  "machine.runtimeAuth.provider.connectAction",
  "machine.runtimeAuth.signIn.done",
  "machine.runtimeAuth.signIn.openPage",
  "machine.runtimeAuth.signIn.retry",
  "machine.runtimeAuth.signIn.submitCode",
  "machine.runtimeAuth.signInAction",
  "machine.runtimeAuth.signOut.confirm",
  "machine.runtimeAuth.signOutAction",
  "machine.runtimeUsage.limitReset.action",
  "machine.runtimeUsage.limitReset.confirm",
  "machine.runtimeUsage.claudeReset.viewAction",
  "machine.runtimeUsage.claudeReset.useFiveHourAction",
  "machine.runtimeUsage.claudeReset.useSelectedAction",
  "machine.runtimeUsage.claudeReset.consentConfirm",
  "machine.runtimeUsage.claudeReset.confirm",
  "machine.versionNotice.installGuide",
  "member.detail.removeAction",
  "member.detail.removeMember",
  "member.detail.promoteToMember",
  "member.detail.promoteConfirm",
  "member.detail.selfDemoteConfirm",
  "member.detail.ownerGrantConfirm",
  "member.detail.undo",
  "member.invite.applyLinkOptions",
  "member.invite.sendInvites",
  "member.invite.tabEmail",
  "member.invite.tabLink",
  "member.invite.viewBilling",
  "message.channelFilesPanel.downloadFile",
  "message.channelFilesPanel.jumpToMessage",
  "message.channelFilesPanel.loadMore",
  "message.chatPanel.appBotRemovedSettingsApps",
  "message.chatPanel.backToBottom",
  "message.chatPanel.joinChannel",
  "message.chatPanel.overflow.discardChanges",
  "message.chatPanel.overflow.keepEditing",
  "message.chatPanel.overflow.saveAndClose",
  "message.chatPanel.threadUnreadJumpEarliest",
  "message.chatPanel.threadUnreadJumpNext",
  "message.chatPanel.upgradeForMoreChannels",
  "message.chatPanel.viewBilling",
  "message.composer.cancelRecoveredUpload",
  "message.composer.tapToRetry",
  "message.content.showMore",
  "message.forwardComposer.selectMultiple",
  "message.forwardComposer.tryAgain",
  "message.forwardComposer.viewInChat",
  "message.mermaid.downloadPng",
  "message.mermaid.downloadSource",
  "message.mermaid.downloadSvg",
  "message.attachmentComments.commentOnFile",
  "message.messageItem.addTimestamp",
  "message.messageItem.convertToTask",
  "message.messageItem.copyHandle",
  "message.appLink.connect.action",
  "message.appLink.action.undo.action",
  "message.messageItem.copyLink",
  "message.messageItem.copyMarkdown",
  "message.messageItem.copyName",
  "message.messageItem.customProtocolLink.confirm",
  "webPreview.linkChoice.browser",
  "webPreview.linkChoice.beside",
  "message.messageItem.downloadToView",
  "message.messageItem.followThread",
  "message.messageItem.markAsDone",
  "message.messageItem.markChannelAsUnread",
  "message.messageItem.markDmAsUnread",
  "message.messageItem.openLink",
  "message.messageItem.forward",
  "message.messageItem.previewComment",
  "message.messageItem.removeFromSaved",
  "message.messageItem.reopenTask",
  "message.messageItem.saveMessage",
  "message.messageItem.selectMessage",
  "message.messageItem.showOriginal",
  "message.messageItem.showTranslation",
  "message.messageItem.unfollowThread",
  "message.messageItem.xlsxUnnamedSheet",
  "message.notificationActivation.enable",
  "message.notificationActivation.settingsNotifications",
  "message.pendingMention.addAll",
  "message.selectModeToolbar.copyLink",
  "message.selectModeToolbar.forward",
  "message.selectModeToolbar.generateImage",
  "message.selectShare.copyImage",
  "message.selectShare.saveImage",
  "message.sos.keepStopped",
  "message.sos.resumeAll",
  "message.sos.stopAction",
  "message.threadPanel.closeThread",
  "message.threadPanel.joinChannelToReply",
  "message.threadPanel.overflow.hideChannel",
  "message.threadPanel.overflow.hideConversation",
  "message.threadPanel.overflow.showChannel",
  "message.threadPanel.overflow.showConversation",
  "message.threadPanel.searchInThread",
  "message.threadPanel.viewInChannel",
  "onboarding.computerRuntime.addApiKey",
  "onboarding.computerRuntime.copyInstallCommand",
  "onboarding.computerRuntime.startOver",
  "onboarding.native.retry",
  "pages.agentConnectionCallback.backToAgent",
  "pages.appLogin.approve",
  "pages.appLogin.backToApp",
  "pages.appLogin.openApp",
  "pages.appLogin.useAnotherAccount",
  "pages.deviceLogin.addToServer",
  "pages.deviceLogin.approve",
  "pages.deviceLogin.closePage",
  "pages.deviceLogin.giveKey",
  "pages.deviceLogin.useAnotherAccount",
  "pages.emailVerification.continueToRaft",
  "pages.emailVerification.pasteLinkAction",
  "pages.emailVerification.cancelPasteLink",
  "pages.emailVerification.logOut",
  "pages.emailVerification.resendAction",
  "pages.emailVerification.verifyAction",
  "pages.forgotPassword.submit",
  "pages.humanLogin.continueLogin",
  "pages.humanLogin.findServerAdmin",
  "pages.humanLogin.installAndContinue",
  "pages.humanLogin.logOut",
  "pages.humanLogin.loginWithRaft",
  "pages.identitySetup.submit",
  "pages.integrationInvite.installApp",
  "pages.integrationInvite.openSettings",
  "pages.invite.agreeAndJoin",
  "pages.invite.continueToRaft",
  "pages.invite.createAccount",
  "pages.invite.goToRaft",
  "pages.invite.joinServer",
  "pages.invite.signIn",
  "pages.login.forgotPassword",
  "pages.login.submit",
  "pages.publicServer.cookieSettings",
  "pages.publicServer.join",
  "pages.publicServer.signIn",
  "pages.register.submit",
  "pages.resetPassword.submit",
  "pages.serverNotFound.backToServer",
  "pages.serverNotFound.chooseServer",
  "pages.serverSelector.createNewServerAction",
  "pages.serverSelector.createServerAction",
  "pages.serverSelector.logOut",
  "planBilling.addSeats",
  "planBilling.comparePlans",
  "planBilling.keepPro",
  "planBilling.prepaid.renew",
  "planBilling.manageInStripe",
  "planBilling.manageSeats",
  "planBilling.pastDue.action",
  "planBilling.removeSeats.commit",
  "planBilling.retry",
  "planBilling.upgrade.askOwner",
  "pwa.install.copyLink",
  "pwa.install.gotIt",
  "raftbench.aiAnalyzeAvailableHistory",
  "raftbench.aiApplyScope",
  "raftbench.aiDisable",
  "raftbench.aiEnable",
  "raftbench.aiHistoryDays",
  "raftbench.aiNext",
  "raftbench.aiPrevious",
  "raftbench.all",
  "raftbench.allChannels",
  "raftbench.analyze",
  "raftbench.assignAgent",
  "raftbench.confirm",
  "raftbench.createServiceAgent",
  "raftbench.dismiss",
  "raftbench.loadOverview",
  "raftbench.openSource",
  "raftbench.refresh",
  "saved.copyLink",
  "saved.copyMarkdown",
  "saved.remove",
  "search.clearAll",
  "search.continueSearching",
  "search.loadMore",
  "search.queryTooBroadSortRecent",
  "server.communityAgreement.agreeContinue",
  "settings.account.changePassword",
  "settings.account.saveProfile",
  "settings.account.sendSetupEmail",
  "settings.account.setPasswordByEmail",
  "settings.admins.removeAdmin",
  "settings.admins.removeOwner",
  "settings.admins.updateRole",
  "settings.archivedAgents.viewWorkspace",
  "settings.connectedApps.appIdentity.addHandle",
  "settings.connectedApps.appIdentity.addToServer",
  "settings.connectedApps.appIdentity.decline",
  "settings.connectedApps.appIdentity.remove",
  "settings.connectedApps.appIdentity.viewProfile",
  "settings.connectedApps.appNotifications.approveUpdate",
  "settings.connectedApps.appNotifications.rotateSecret",
  "settings.connectedApps.createLink",
  "settings.connectedApps.deleteApp",
  "settings.connectedApps.editor.regenerateClientSecret",
  "settings.connectedApps.editor.regenerateSecretConfirmLabel",
  "settings.connectedApps.editor.requestOffline",
  "settings.connectedApps.editor.requestOfflineConfirm",
  "settings.connectedApps.installToServer",
  "settings.connectedApps.addApp",
  "settings.mcpApp.register.ownService",
  "settings.mcpApp.register.mcpServer",
  // The Custom MCP App form's link to the Marketplace (and the Installed empty state's button).
  "apps.installed.browseMarketplace",
  "settings.connectedApps.registerApp",
  "settings.connectedApps.registerSubmit",
  "settings.mcpApp.connections.deleteConfirm",
  "settings.connectedApps.requestPublish",
  "settings.connectedApps.tabMyApps",
  "settings.connectedApps.uninstallApp",
  "settings.connectedApps.uninstallFromServer",
  "settings.connectedApps.uninstallingConfirm",
  "settings.dangerZone.deleteServer",
  "settings.dangerZone.leaveServer",
  "settings.dangerZone.leaveServerConfirm",
  "settings.invites.confirmLabel",
  "settings.joinLinks.confirmLabel",
  "settings.joinLinks.createLink",
  "settings.mobileApp.android",
  "settings.mobileApp.googlePlay",
  "settings.mobileApp.ios",
  "settings.notifications.disable",
  "settings.notifications.enable",
  "settings.notifications.desktop.openSystemSettings",
  "settings.notifications.pause.apply",
  "settings.notifications.pause.resume",
  "settings.notifications.servers.resetToDefault",
  "settings.notifications.test.send",
  "settings.notifications.test.waiting",
  "settings.onboarding.finishSetup",
  "settings.providers.add",
  "settings.providers.agentCount",
  "settings.providers.agentCountOne",
  "settings.providers.create",
  "settings.providers.refreshModels",
  "settings.providers.saveChanges",
  "settings.providers.sendTest",
  "settings.providers.verifyAgain",
  "settings.providers.verifyStart",
  "settings.publicVisibility.confirmAction",
  "settings.serverProfile.saveProfile",
  "settings.session.confirmLabel",
  "settings.session.logOutAction",
  // Settings › Account › Two-step verification (#triage:#135).
  "settings.twoStep.choose",
  "settings.twoStep.codesCopied",
  "settings.twoStep.copyCodes",
  "settings.twoStep.done",
  "settings.twoStep.downloadCodes",
  "settings.twoStep.regenerate",
  "settings.twoStep.signInAgainButton",
  "settings.twoStep.turnOff",
  "settings.twoStep.turnOn",
  "settings.twoStep.useAuthenticatorCode",
  "settings.twoStep.useBackupCode",
  "settings.twoStep.usePasskey",
  "settings.twoStep.verify",
  // Settings › Account › Passkeys (#triage:#135).
  "settings.passkeys.add",
  "settings.passkeys.delete",
  "settings.passkeys.deleteConfirm",
  "settings.passkeys.rename",
  "settings.passkeys.renameSave",
  "settings.slackBridge.applyPairChanges",
  "settings.slackBridge.authorize",
  "settings.slackBridge.connect",
  "settings.slackBridge.disconnect",
  "settings.slackBridge.disconnectConfirm",
  "settings.slackBridge.finishSetup",
  "settings.slackBridge.managePairs",
  "settings.slackBridge.reauthorize",
  "settings.slackBridge.refreshAndRecheck",
  "settings.slackBridge.retryFinishSetup",
  "settings.slackBridge.showInviteSteps",
  "task.backlogReason.confirm",
  "task.handoffReason.confirm",
  "task.board.newTask",
  "task.create.addAnother",
  "task.create.submit",
  // The New task dialog's button on task v2 (CreateTaskMessageDialog).
  "task.create.sendAndCreateTask",
  "task.panel.clearAll",
  "task.panel.loadMore",
  // The Tasks page (hifi v4): New task, the sort menu's items, the selection bar's actions.
  "task.page.newTask",
  "task.page.sort.activity",
  "task.page.sort.activityAsc",
  "task.page.sort.created",
  "task.page.batch.follow",
  "task.page.batch.delete",
  "task.page.batch.deleteAction",
  "thread.contextMenu.markAsRead",
  "thread.contextMenu.markAsUnread",
  "thread.filter.all",
  "thread.filter.button",
  "thread.filter.mentions",
  "thread.filter.pinned",
  "thread.filter.saved",
  "thread.filter.unread",
  "thread.markAllRead.label",
  "ui.serverSwitcher.switchOrCreate",
  "upgradeDialog.pricing",
  "upgradeDialog.reopen",
  "upgradeDialog.retry",
  "upgradeDialog.send",
  "upgradeDialog.sendToOwner",
  "upgradeDialog.view",
] as const satisfies readonly (keyof typeof en)[];

/**
 * Fallback for labels nobody pinned: an en id whose key reads like a clickable
 * label must be in CLICKABLE_LABEL_IDS or in EXEMPT_LABEL_IDS below. The
 * patterns stay tight on purpose; widen them only when a real miss shows up.
 */
const CLICKABLE_KEY_SEGMENTS = new Set(["button", "action", "confirm", "cta", "submit", "menu"]);
const CLICKABLE_KEY_SUFFIX = /[a-z0-9](?:Button|Action|Confirm|Cta|Menu|MenuItem)$/;

function looksLikeClickableLabelId(id: string): boolean {
  const segments = id.split(".");
  const last = segments[segments.length - 1];
  if (CLICKABLE_KEY_SEGMENTS.has(last) || CLICKABLE_KEY_SUFFIX.test(last)) return true;
  return last === "label" && segments.slice(0, -1).includes("actions");
}

/** Ids whose key looks clickable but whose text is not a visible clickable label. */
const EXEMPT_LABEL_IDS = {
  "accountDeletion.groupNeedsAction": "a group label inside Delete Account's list, not a control",
  "assistant.otter.meta.confirm": "the assistant panel's status line, not a control",
  "assistant.otter.state.confirm": "the otter's bubble and the state in its aria-label, not a control",
  "channel.jointInvite.sameAdmin.confirm": "checkbox label written as a sentence",
  "inAppBrowserGuide.stepMenu": "a step's title in Steps, not a control",
  "keyboardShortcuts.openActionsMenu": "a row of the keyboard shortcuts list, read, not pressed",
  "keyboardShortcuts.commentOtherAction": "a row of the keyboard shortcuts list, read, not pressed",
  "keyboardShortcuts.reserved.browserMenu": "the panel's reason a key can't be recorded, a sentence, not a control",
  "keyboardShortcuts.reserved.windowsStartMenu": "the panel's reason a key can't be recorded, a sentence, not a control",
  "keyboardShortcuts.reserved.windowsWindowMenu": "the panel's reason a key can't be recorded, a sentence, not a control",
  "message.composer.failedMentionAction": "error message, not a label",
  "message.mermaid.downloadMenu": "tooltip and aria-label of an icon button",
  "message.messageItem.messageContextMenu": "aria-label only",
  "message.messageItem.senderContextMenu": "aria-label only",
  "pages.identitySetup.titleConfirm": "page title, sentence case",
  "settings.providers.deleteConfirm": "window.confirm prompt sentence",
  "settings.providers.detachConfirm": "window.confirm prompt sentence",
  "task.item.deleteConfirm": "confirm prompt sentence",
  "task.page.batch.deleteConfirm": "the Tasks page's delete dialog title (a question); its button is task.page.batch.deleteAction",
} as const satisfies Partial<Record<keyof typeof en, string>>;

/** A sentence or a paragraph: the catalog-wide Title Case check leaves these alone. */
function isProse(value: string): boolean {
  return /[.!](\s|$|\})/.test(value) || value.replace(/\{[^{}]*\}/g, "x").split(/\s+/).length > 9;
}

/** Short en values that read as Title Case but are not labels this rule covers. */
const TITLE_CASE_EXEMPT_IDS = {
  "pages.serverSelector.serverNamePlaceholder": "an example server name (a person's own casing)",
  "pages.serverSelector.serverNamePlaceholderTeam": "an example server name (a person's own casing)",
  "settings.connectedApps.appNamePlaceholder": "an example app name (a person's own casing)",
  "settings.mcpApp.profile.namePlaceholder": "an example app name (a person's own casing)",
  "layout.sidebar.sectionNamePlaceholder": "an example section name (a person's own casing)",
  "pages.identitySetup.displayNamePlaceholder": "an example person's name",
  "pages.identitySetup.previewSampleName": "an example person's name",
  "inAppBrowserGuide.stepOpenSafari": "quotes Safari's and WeChat's own menu item",
  "inAppBrowserGuide.stepOpenBrowser": "quotes the in-app browser's own menu item",
  "activity.log.compactionStarted": "an activity event line, out of scope for the 2026-11-05 rule",
  "activity.log.compactionFinished": "an activity event line, out of scope for the 2026-11-05 rule",
  "mention.activity.compactionStarted": "an activity event line, out of scope for the 2026-11-05 rule",
  "mention.activity.compactionFinished": "an activity event line, out of scope for the 2026-11-05 rule",
  "machine.runtimeAuth.thisComputer": "a fragment substituted into status sentences (Starting sign-in on {computer}…)",
  "agent.archive.unknownComputer": "a fragment substituted into sentences, in place of a computer's name",
} as const satisfies Partial<Record<keyof typeof en, string>>;

test("isSentenceCase follows the Raft casing rule", () => {
  for (const label of [
    "Save",
    "Create task",
    "Mark all as read",
    "Move to section",
    "Sign in",
    "Back to sign in",
    "Invite members",
    "Visible to guests",
    "In progress",
    "Open Settings",
    "Remove from Saved",
    "Mark as Done",
    "Reopen to Todo",
    "Fork in Raft",
    "Create joint channel",
    "Browse marketplace",
    "Mark as unread",
    "Load more Artifacts",
    "Copy Markdown",
    "Upgrade to Pro",
    "Add MCP server",
    "Connect a new GitHub account",
    "Get the iOS beta",
    "Windows x64",
    "Share to X",
    "Show all {count} channels",
    "Add {count, plural, one {# member} other {# members}}",
    "Join #{channel}",
    "Restart / reset",
    "Send as task (⌘/Ctrl-Shift-Enter)",
    "Task #{taskNumber} · Legacy",
    "What's new",
    "I'll set this up myself",
  ]) {
    assert.equal(isSentenceCase(label), true, `${JSON.stringify(label)} should pass`);
  }
  for (const label of [
    "Create Task",
    "Mark All as Read",
    "Back to Sign In",
    "Invite People",
    "Visible to Guests",
    "Create Joint Channel",
    "Browse Marketplace",
    "Mark as Unread",
    "In Progress",
    "Sign-In options",
    "Show All {count} Channels",
    "Add {count, plural, one {# Member} other {# members}}",
    "Change {count} {count, plural, one {agent} other {Agents}}",
    "Verify again (One provider call)",
    "Reset Session & restart",
  ]) {
    assert.equal(isSentenceCase(label), false, `${JSON.stringify(label)} should fail`);
  }
});

test("isTitleCased flags Title Case, not a sentence that capitalizes one noun", () => {
  for (const label of ["Create Task", "Move to Another Computer", "Context Compaction Started", "Add {count} Seats"]) {
    assert.equal(isTitleCased(label), true, `${JSON.stringify(label)} is Title Case`);
  }
  for (const label of [
    "Create task",
    "Raft Desktop",
    "Open in Agent Lounge",
    "Open System Settings",
    "Failed to update Guest access",
    "Its Computer is too old: reinstall or upgrade it",
  ]) {
    assert.equal(isTitleCased(label), false, `${JSON.stringify(label)} is not Title Case`);
  }
});

test("pinned clickable labels are unique en ids", () => {
  assert.equal(new Set(CLICKABLE_LABEL_IDS).size, CLICKABLE_LABEL_IDS.length);
  for (const id of CLICKABLE_LABEL_IDS) assert.ok(id in en, `${id} is not an en message id`);
});

test("looksLikeClickableLabelId matches clickable-looking keys only", () => {
  for (const id of [
    "auth.backToSignIn.button",
    "machine.detail.bulkModel.button",
    "settings.foo.saveButton",
    "channel.edit.archiveAction",
    "pages.emailVerification.verifyAction",
    "handoff.wizard.confirm",
    "agent.migration.cancelDialogConfirm",
    "pages.identitySetup.avatarCta",
    "billing.cta",
    "pages.login.submit",
    "desktop.history.menu",
    "layout.sidebar.newSectionMenu",
    "layout.sidebar.renameMenuItem",
    "task.actions.label",
    "message.actions.copy.label",
  ]) {
    assert.equal(looksLikeClickableLabelId(id), true, `${id} should match`);
  }
  for (const id of [
    "task.create.title",
    "settings.foo.label",
    "settings.actionsHint.label",
    "settings.foo.submitting",
    "settings.foo.onSubmit",
    "settings.foo.confirmed",
    "settings.foo.actionable",
    "settings.foo.menuTitle",
    "settings.foo.buttons",
    "settings.Button",
    "agent.migration.cancelPreMessage",
  ]) {
    assert.equal(looksLikeClickableLabelId(id), false, `${id} should not match`);
  }
});

test("exempt ids are en ids that the fallback would catch and are not pinned", () => {
  const pinned = new Set<string>(CLICKABLE_LABEL_IDS);
  for (const [id, reason] of Object.entries(EXEMPT_LABEL_IDS)) {
    assert.ok(id in en, `${id} is not an en message id; remove it from EXEMPT_LABEL_IDS`);
    assert.ok(looksLikeClickableLabelId(id), `${id} does not look clickable; remove it from EXEMPT_LABEL_IDS`);
    assert.ok(!pinned.has(id), `${id} is both pinned and exempt`);
    assert.ok(reason.trim(), `${id} needs a reason`);
  }
});

test("every clickable-looking en id is pinned or exempt", () => {
  const known = new Set<string>([...CLICKABLE_LABEL_IDS, ...Object.keys(EXEMPT_LABEL_IDS)]);
  const unlisted = Object.keys(en).filter((id) => looksLikeClickableLabelId(id) && !known.has(id));
  assert.deepEqual(
    unlisted,
    [],
    "These en ids look like clickable labels but are in neither list in tests/clickableLabelTitleCase.test.ts.\n" +
      "Add each to CLICKABLE_LABEL_IDS if it is the visible label of a clickable control (it must be sentence case),\n" +
      "or to EXEMPT_LABEL_IDS with a one-line reason if it is not (aria-label, tooltip, sentence):\n" +
      unlisted.join("\n"),
  );
});

test("every clickable label in the en catalog is sentence case", () => {
  const violations = CLICKABLE_LABEL_IDS.filter((id) => !isSentenceCase(en[id])).map(
    (id) => `${id}: ${JSON.stringify(en[id])}`,
  );
  assert.deepEqual(
    violations,
    [],
    "Clickable labels use sentence case (Raft Design System, content/writing.md#casing):\n" + violations.join("\n"),
  );
});

test("no short en value is written in Title Case", () => {
  // Tooltips, aria-labels, tabs and dialog titles are not all pinned above; a
  // Title Case value anywhere in the catalog is the casing coming back.
  const exempt = new Set<string>(Object.keys(TITLE_CASE_EXEMPT_IDS));
  const violations = Object.entries(en as Record<string, string>)
    .filter(([id, value]) => !id.startsWith("fixtures.") && !exempt.has(id) && !isProse(value) && isTitleCased(value))
    .map(([id, value]) => `${id}: ${JSON.stringify(value)}`);
  assert.deepEqual(
    violations,
    [],
    "Labels are sentence case; keep a later capital only for a name, destination, status, key or acronym\n" +
      "(NAMES / PHRASES in tests/clickableLabelTitleCase.test.ts):\n" + violations.join("\n"),
  );
});

test("Title Case exemptions are en ids that the check would catch", () => {
  for (const [id, reason] of Object.entries(TITLE_CASE_EXEMPT_IDS)) {
    const value = (en as Record<string, string>)[id];
    assert.ok(value !== undefined, `${id} is not an en message id; remove it from TITLE_CASE_EXEMPT_IDS`);
    assert.ok(isTitleCased(value), `${id} is no longer Title Case; remove it from TITLE_CASE_EXEMPT_IDS`);
    assert.ok(reason.trim(), `${id} needs a reason`);
  }
});
