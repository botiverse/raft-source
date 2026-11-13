import { useEffect, useMemo, useState } from "react";
import type { ComponentProps } from "react";

import { en as EN_MESSAGES } from "../src/i18n/messages/en";
import { Route, Routes } from "react-router-dom";
import {
  Badge,
  Select,
  SelectContent,
  SelectIcon,
  SelectItem,
  SelectItemIndicator,
  SelectItemText,
  SelectList,
  SelectTrigger,
  SelectValue,
  SegmentedControl,
  SegmentedControlCount,
  SegmentedControlItem,
  SegmentedControlLabel,
  Button,
  Textarea,
  TextareaCounter,
  Checkbox,
  CheckboxIndicator,
  Input,
  Skeleton,
  ListRowGroup,
} from "@botiverse/raft-ui";
import LoginPage from "../src/components/auth/LoginPage";
import { AgentDetailPanel } from "../src/features/agent/AgentDetailPanel";
import { CreateAgentDialog } from "../src/features/agent/CreateAgentDialog";
import { ChannelMembers } from "../src/features/channel/ChannelMembers";
import CreateChannelDialog from "../src/components/channel/CreateChannelDialog";
import InviteHumanDialog from "../src/components/member/InviteHumanDialog";
import ForwardComposerDialog from "../src/components/message/ForwardComposerDialog";
import { AttachmentCommentsPanel } from "../src/components/message/AttachmentCommentsPanel";
import { Sidebar } from "../src/features/sidebar/Sidebar";
import NotificationTrigger from "../src/components/layout/NotificationTrigger";
import type { NotificationEntry } from "../src/components/layout/useSystemNotifications";
import MainLayout, { MobileTabBar } from "../src/components/layout/MainLayout";
import { ChatPanel } from "../src/features/channel/ChatPanel";
import ChannelFilesPanel from "../src/components/message/ChannelFilesPanel";
import MessageItem, { buildMentionMap } from "../src/components/message/MessageItem";
import { MessageInput } from "../src/features/composer/MessageInput";
import ExternalIdentityDetailPanel from "../src/components/profile/ExternalIdentityDetailPanel";
import NotificationActivationBanner from "../src/components/message/NotificationActivationBanner";
import SelectModeToolbar from "../src/components/message/SelectModeToolbar";
import { MessageSearchPage } from "../src/features/search/MessageSearchPage";
import AvatarListRow from "../src/components/ui/AvatarListRow";
import AvatarSlot from "../src/components/ui/AvatarSlot";
import FormField from "../src/components/ui/FormField";
import MenuItem from "../src/components/ui/MenuItem";
import { SelectionPopoverPanel } from "../src/components/ui/SelectionPopover";
import { SkeletonRow } from "../src/components/ui/Skeleton";
import SlugInput from "../src/components/ui/SlugInput";
import SurfaceListItem from "../src/components/ui/SurfaceListItem";
import InlineBadgeEditor from "../src/components/InlineBadgeEditor";
import TasksPanel from "../src/components/task/TasksPanel";
import FeedbackSdkTrial from "./FeedbackSdkTrial";
import { VisualMessageRow } from "./VisualMessageRow";
import SelectSharePreviewPrototype from "./SelectSharePreviewPrototype";
import { FILE_VIEWER_CASE_IDS, FileViewerCase } from "./FileViewerCases";
import { MESSAGE_CARD_CASE_IDS, MessageCardCase } from "./MessageCardCases";
import { AGENT_READ_LINE_CASE_IDS, AgentReadLineCase } from "./AgentReadLineCases";
import { ACTION_CARD_CASE_IDS, ActionCardCase } from "./ActionCardCases";
import { ASSISTANT_OTTER_CASE_IDS, AssistantOtterCase } from "./AssistantOtterCases";
import { EXTERNAL_AGENT_CREATE_CASE_IDS, ExternalAgentCreateCase } from "./ExternalAgentCreateCases";
import { EXTERNAL_AGENT_PAGE_CASE_IDS, ExternalAgentPageCase } from "./ExternalAgentPageCases";
import { AGENT_CONTEXT_VIEW_CASE_IDS, AgentContextViewCase } from "./AgentContextViewCases";
import { AGENT_ACTIVITY_LOG_CASE_IDS, AgentActivityLogCase } from "./AgentActivityLogCases";
import { ARTIFACT_FILTER_CASE_IDS, ArtifactFilterCase } from "./ArtifactFilterCases";
import { COMPUTERS_RACK_CASE_PATH, ComputersRackCase, isComputersRackCase } from "./ComputersRackCases";
import { isOpenInAppOfferCase, OPEN_IN_APP_OFFER_CASE_PATH, OpenInAppOfferCase } from "./OpenInAppOfferCases";
import { STATUS_STYLES } from "../src/components/task/taskStatusUi";
import { SettingsPanel } from "../src/components/settings/SettingsPanel";
import { IntegrationsSection } from "../src/features/apps/IntegrationsSection";
import PaletteAuditPage from "../src/pages/PaletteAuditPage";
import SavedPanel from "../src/components/saved/SavedPanel";
import { ThreadsInbox } from "../src/features/thread/ThreadsInbox";
import { useAuthStore } from "../src/store/authStore";
import { useAgentStore } from "../src/store/agentStore";
import { useChannelStore } from "../src/store/channelStore";
import type { Channel } from "../src/store/channelStore";
import { useInboxStore } from "../src/store/inboxStore";
import { useMachineStore } from "../src/store/machineStore";
import type { Machine } from "../src/store/machineStore";
import { useMessageStore } from "../src/store/messageStore";
import type { Message } from "../src/store/messageStore";
import { useSavedStore } from "../src/store/savedStore";
import {
  getModelLabel,
  PROVIDER_CONNECTIONS_FEATURE_FLAG_KEY,
  RUNTIME_ERROR_CODE_SENTENCES,
  SERVER_GUEST_FEATURE_FLAG_KEY,
} from "@botiverse/raft-shared";
import { useModelLabelCatalogStore } from "../src/store/modelLabelCatalogStore";
import { setServerFeatureFlagForTests } from "../src/store/serverFeatureFlags";
import { useServerStore } from "../src/store/serverStore";
import { useSelectionStore } from "../src/store/selectionStore";
import { useTaskStore } from "../src/store/taskStore";
import type { Task } from "../src/store/taskStore";
import { useThreadStore } from "../src/store/threadStore";
import type { ThreadSummary } from "../src/store/threadStore";
import fixtureData from "../../visual-testing/shared/fixtureData.json";
import sharedCases from "../../visual-testing/shared/sharedCases.json";
import savedMessagesFixture from "../../visual-testing/shared/savedMessagesFixture.json";
import activityResultsFixture from "../../visual-testing/shared/activityResultsFixture.json";
import tasksFixture from "../../visual-testing/shared/tasksFixture.json";
import { homeChannelListFollowedThreads } from "./homeChannelList";

const fxOwner = fixtureData.humans.owner;
const fxDesigner = fixtureData.humans.designer;
const fxCindy = fixtureData.agents.cindy;
const fxProductUx = fixtureData.agents.productUx;
const fxAndroidDev = fixtureData.agents.androidDev4;
const fxPrimaryMachine = fixtureData.machines.primary;
const fxStudioMachine = fixtureData.machines.studio;
const fxLongNameMachine = fixtureData.machines.longName;
const fxDaemonOnlyMachine = fixtureData.machines.daemonOnly;
const fxServer = fixtureData.server;
const fxChannels = fixtureData.channels;
const fxTimes = fixtureData.times;
const fxMessages = fixtureData.messages;

/** Fixture callbacks: visual cases render controls but never act on them. */
function noop() {}

async function asyncNoop() {}

type VisualSelectOption = {
  value: string;
  label: string;
  disabled?: boolean;
};

function renderVisualSelectItems(options: readonly VisualSelectOption[]) {
  return options.map((option) => (
    <SelectItem key={option.value} value={option.value} disabled={option.disabled}>
      <SelectItemText>{option.label}</SelectItemText>
      <SelectItemIndicator />
    </SelectItem>
  ));
}

const VISUAL_SELECT_OPTIONS: readonly VisualSelectOption[] = [
  { value: "codex", label: "Codex" },
  { value: "claude", label: "Claude" },
  { value: "disabled", label: "Unavailable Runtime", disabled: true },
];

const VISUAL_DISABLED_SELECT_OPTIONS: readonly VisualSelectOption[] = [
  { value: "codex", label: "Codex" },
];

type ComposerVisualCase = {
  id: string;
  visualCaseAttr: string;
  draft: string;
  placeholder: string;
  height?: number;
  composerOffsetTop?: number;
  pendingMentionActionsAfterSend?: boolean;
  width?: number;
  activationPlacement?: "desktop" | "mobile";
};

type AuthVisualCase = {
  id: string;
  mode: "login";
};

const AUTH_CASES: Record<string, AuthVisualCase> = {
  "auth.login.inputs.empty": {
    id: "auth.login.inputs.empty",
    mode: "login",
  },
  "auth.login.inputs.filled": {
    id: "auth.login.inputs.filled",
    mode: "login",
  },
  "auth.login.inputs.invalid": {
    id: "auth.login.inputs.invalid",
    mode: "login",
  },
};

const COMPOSER_CASES: Record<string, ComposerVisualCase> = {
  "components.thread.composer.empty": {
    id: "components.thread.composer.empty",
    visualCaseAttr: "components.thread.composer.empty",
    draft: "",
    placeholder: fxMessages.composerPlaceholder,
  },
  "components.thread.composer.states": {
    id: "components.thread.composer.states",
    visualCaseAttr: "components.thread.composer.states",
    draft: fxMessages.composerSeed,
    placeholder: fxMessages.composerPlaceholder,
  },
  "components.thread.composer.pending-mention-actions": {
    id: "components.thread.composer.pending-mention-actions",
    visualCaseAttr: "components.thread.composer.pending-mention-actions",
    draft: "@Android-Developer-4 please review the visual diff",
    placeholder: fxMessages.composerPlaceholder,
    height: 290,
    pendingMentionActionsAfterSend: true,
  },
  "components.thread.composer.as-task-selected": {
    id: "components.thread.composer.as-task-selected",
    visualCaseAttr: "components.thread.composer.states",
    draft: fxMessages.composerSeed,
    placeholder: fxMessages.composerPlaceholder,
  },
  "components.thread.composer.member-suggestions": {
    id: "components.thread.composer.member-suggestions",
    visualCaseAttr: "components.thread.composer.member-suggestions",
    draft: "",
    placeholder: fxMessages.composerPlaceholder,
    // The suggestion list opens above the composer; the old 320px box with
    // the composer 210px down cut the list's top section off. Leave room for
    // the whole list and let the height follow the content.
    composerOffsetTop: 250,
  },
  "components.thread.composer.channel-suggestions": {
    id: "components.thread.composer.channel-suggestions",
    visualCaseAttr: "components.thread.composer.channel-suggestions",
    draft: "",
    placeholder: fxMessages.composerPlaceholder,
    height: 320,
    composerOffsetTop: 210,
  },
  "components.thread.composer.image-preview": {
    id: "components.thread.composer.image-preview",
    visualCaseAttr: "components.thread.composer.image-preview",
    draft: fxMessages.composerImagePreviewSeed,
    placeholder: fxMessages.composerPlaceholder,
    height: 210,
  },
  "components.thread.composer.file-previews": {
    id: "components.thread.composer.file-previews",
    visualCaseAttr: "components.thread.composer.file-previews",
    draft: fxMessages.composerFilePreviewsSeed,
    placeholder: fxMessages.composerPlaceholder,
    height: 270,
  },
  "components.activation.notifications.desktop": {
    id: "components.activation.notifications.desktop",
    visualCaseAttr: "components.activation.notifications.desktop",
    draft: "",
    placeholder: fxMessages.composerPlaceholder,
    width: 760,
    height: 190,
    activationPlacement: "desktop",
  },
  "components.activation.notifications.mobile": {
    id: "components.activation.notifications.mobile",
    visualCaseAttr: "components.activation.notifications.mobile",
    draft: "",
    placeholder: fxMessages.composerPlaceholder,
    width: 342,
    height: 220,
    activationPlacement: "mobile",
  },
};

const VISUAL_CHANNEL_ID = fxChannels.composerHost.id;
const VISUAL_MACHINE_ID = fxPrimaryMachine.id;


// All five selectable statuses, in the order getTaskStatusOptions yields
// them for a server manager — labels stay in lockstep with STATUS_STYLES.
const TASK_STATUS_MENU_OPTIONS = (
  ["todo", "in_progress", "in_review", "done", "closed"] as const
).map((status) => ({ id: status, label: EN_MESSAGES[STATUS_STYLES[status].labelId] }));

type CreateAgentVisualCase = {
  id: string;
  runtime: string;
  machineRuntimes: string[];
  /** Seed the name field so the inline validation error renders (error-state baseline). */
  prefilledName?: string;
  /** Render with nothing pre-filled: no name, no description. The empty state
   *  had no coverage — every existing case seeds values, so a field's empty
   *  rendering was never captured. */
  empty?: boolean;
  /** Seed zero machines so the dialog renders its "connect a computer first"
   *  branch — a distinct screen with its own button set, not a variant of the form. */
  noMachines?: boolean;
  /** Seed billing at the agent cap so the dialog renders its capacity `Banner`.
   *
   *  Neither of this dialog's two Banners had ANY visual coverage: the capacity
   *  one needs billing state no case seeded, and the submit-error one needs a
   *  failed request. `dialog-error` sounds like it would cover the latter, but it
   *  seeds a bad NAME — which surfaces in the field's error row, not a Banner.
   *
   *  That blind spot is the same one that hid the external-purpose selector's
   *  hardcoded styling (#7034): a surface that renders in no case cannot regress
   *  visibly. Added while rui's Banner is being fixed, so the swap has something
   *  to be captured against. */
  atCapacity?: boolean;
};

type AgentDetailVisualCase = {
  id: string;
  route?: "members-agent-detail" | "members-human-detail";
  /** Fixture agent to open. Default productUx. task #535: the Computer-row
      state cases each bind a different fixture agent whose machineKey encodes
      the state (studio = known+offline, missing = dangling id, null = none). */
  agentKey?: keyof typeof fixtureData.agents;
  /** Agent-detail tab. Default = last id segment, which is wrong for the
      dotted state suffixes below, so they set it explicitly. */
  tab?: string;
  /** Seed the machine store as still loading (no machines yet). artin
      2026-09-03 17:17: the Computer row must not appear until computers have
      loaded, on both ends. Web today flashes "No computer assigned" here —
      that is the known-wrong reference, so this cell is expected to differ
      until both ends implement the rule. */
  machinesLoading?: boolean;
  /** #proj-raft-computer:#48 (reconciler step 4b): the profile's status chip
      for an agent whose provider credential is invalid, with Retry.
        held-sign-in  held for another agent's rejected sign-in (credentialHold)
        own-billing   its own BillingError (stored lastRuntimeError, live error)
        member-view   held, seen by a member who may restart it but not see its
                      details: plain Error + Retry */
  credentialStatus?: "held-sign-in" | "own-billing" | "member-view";
  /** #wg-rbac:#57: an agent in a coded runtime error (usage_limit), as a
      member (no error text, the code's sentence) or a manager (the code's
      sentence over the scrubbed detail) sees it. */
  runtimeErrorView?: "member" | "manager";
};

/** How a fixture agent's machineKey becomes the store's machineId. "missing"
    is deliberately NOT a key of fixtureData.machines: that is the dangling-id
    state (web AgentDetailPanel: agentMachine null -> "No computer assigned"). */
function machineIdForFixtureAgent(agent: { machineKey: string | null }): string | null {
  if (agent.machineKey === null) return null;
  if (agent.machineKey === "missing") return "computer-missing";
  const machine = (fixtureData.machines as Record<string, { id: string } | undefined>)[agent.machineKey];
  if (!machine) throw new Error(`fixture agent machineKey "${agent.machineKey}" is not a machines key`);
  return machine.id;
}

type CreateChannelVisualCase = {
  id: string;
};

type DirectVisualCase = {
  id: string;
  kind:
    | "tokens"
    | "ui-typography-specimen"
    | "ui-avatar-list-row"
    | "ui-badge"
    | "ui-button"
    | "ui-card"
    | "ui-check-marker"
    | "ui-checkbox"
    | "ui-form-field"
    | "ui-select"
    | "ui-selection-popover"
    | "ui-menu-item"
    | "ui-segmented-control"
    | "ui-skeleton"
    | "ui-slug-input"
    | "ui-surface-list-item"
    | "ui-textarea"
    | "navigation-tabbar"
    | "home-titlebar"
    | "thread-header"
    | "thread-files"
    | "notification-center"
    | "thread-message"
    | "thread-message-deleted-human"
    | "thread-message-menu"
    | "thread-message-share-selection"
    | "thread-message-share-preview"
    | "thread-message-rich"
    | "thread-message-long-inline-code"
    | "thread-message-md-link-ref"
    | "thread-message-md-latest-release"
    | "thread-message-md-wrap-slice1"
    | "thread-message-md-wrap-clarify"
    | "thread-message-md-wrap-adjacent"
    | "thread-message-md-wrap-status606"
    | "thread-message-md-wrap-task607"
    | "thread-message-agent-read-line"
    | "thread-forward-modal"
    | "thread-comment-anchor"
    | "channel-members"
    | "channel-settings"
    | "search"
    | "saved-results"
    | "activity-results"
    | "tasks-panel"
    | "tasks-toolbar-row"
    | "tasks-status-menu"
    | "external-identity-detail";
};

type SettingsVisualCase = {
  id: string;
  tab?: "account" | "server" | "administration" | "billing" | "language-region" | "appearance" | "notifications" | "integrations";
  root?: boolean;
  // Phone tab root rendered as the inline Sidebar at this route (default: settings).
  rootRoute?: "settings" | "members" | "home";
  // full-height (task #388): render the whole Settings route at content height
  // (unclamped chrome) and capture it fullPage, pairing with the Android eager
  // full-height capture instead of the viewport-clipped scroll container.
  fullHeight?: boolean;
};

const CREATE_AGENT_CASES: Record<string, CreateAgentVisualCase> = {
  "components.members.create-agent.dialog": {
    id: "components.members.create-agent.dialog",
    runtime: "codex",
    machineRuntimes: ["codex", "claude"],
  },
  // Error-state baseline: an invalid name (spaces + punctuation fail NAME_REGEX)
  // renders the inline validation error, so `data-invalid` styling is captured
  // rather than only verified by reading the component recipe.
  "components.members.create-agent.dialog-error": {
    id: "components.members.create-agent.dialog-error",
    runtime: "codex",
    machineRuntimes: ["codex", "claude"],
    prefilledName: "bad name!!",
  },
  // Empty state: no name, no description — the placeholder rendering of every
  // field, which no other case exercises.
  "components.members.create-agent.dialog-empty": {
    id: "components.members.create-agent.dialog-empty",
    runtime: "codex",
    machineRuntimes: ["codex", "claude"],
    empty: true,
  },
  // The "no computer yet" branch: a separate screen (its own close/cancel/CTA set),
  // reached whenever the account has zero machines.
  "components.members.create-agent.dialog-capacity-banner": {
    id: "components.members.create-agent.dialog-capacity-banner",
    runtime: "codex",
    machineRuntimes: ["codex", "claude"],
    atCapacity: true,
  },
  "components.members.create-agent.dialog-no-computer": {
    id: "components.members.create-agent.dialog-no-computer",
    runtime: "codex",
    machineRuntimes: ["codex", "claude"],
    noMachines: true,
  },
  "components.members.create-agent.claude-dialog": {
    id: "components.members.create-agent.claude-dialog",
    runtime: "claude",
    machineRuntimes: ["claude", "codex"],
  },
  "components.members.create-agent.claude-custom-provider-dialog": {
    id: "components.members.create-agent.claude-custom-provider-dialog",
    runtime: "claude",
    machineRuntimes: ["claude", "codex"],
  },
  // task #9: the built-in provider fields (its API key and gateway Base URL) and
  // the schema-driven runtime form only render when the machine actually offers
  // the `builtin` runtime. Every pre-existing case seeds ["claude","codex"], so
  // `builtin` was unreachable and those migrated inputs had no coverage at all —
  // the runtime select renders, opens, and is simply empty of that option.
  "components.members.create-agent.builtin-provider-dialog": {
    id: "components.members.create-agent.builtin-provider-dialog",
    runtime: "builtin",
    machineRuntimes: ["builtin", "claude", "codex"],
  },
  // Same reason for the Pi provider API key: it is gated on runtime === "pi".
  "components.members.create-agent.pi-provider-dialog": {
    id: "components.members.create-agent.pi-provider-dialog",
    runtime: "pi",
    machineRuntimes: ["pi", "claude", "codex"],
  },
};

const AGENT_DETAIL_CASES: Record<string, AgentDetailVisualCase> = {
  "components.members.agent-detail.profile": {
    id: "components.members.agent-detail.profile",
  },
  "screens.members.agent-detail.profile": {
    id: "screens.members.agent-detail.profile",
    route: "members-agent-detail",
  },
  /* task #535 — Computer-row oracle states. Expected web rendering per
     AgentDetailPanel.tsx (blob c549c316acf5, :771-772 and :2053-2084):
       computer-offline  store knows the machine, status offline -> gray dot + Offline
       computer-missing  machineId set, machine not in store    -> "No computer assigned", no dot
       no-computer       machineId null                         -> "No computer assigned", no dot
     The default profile case already covers "known + online" (lime dot). */
  "screens.members.agent-detail.profile.computer-offline": {
    id: "screens.members.agent-detail.profile.computer-offline",
    route: "members-agent-detail",
    agentKey: "computerOffline",
    tab: "profile",
  },
  "screens.members.agent-detail.profile.computer-missing": {
    id: "screens.members.agent-detail.profile.computer-missing",
    route: "members-agent-detail",
    agentKey: "computerMissing",
    tab: "profile",
  },
  "screens.members.agent-detail.profile.no-computer": {
    id: "screens.members.agent-detail.profile.no-computer",
    route: "members-agent-detail",
    agentKey: "noComputer",
    tab: "profile",
  },
  /* task #537 — a machine name that cannot fit one 390dp line, so the
     wrap / silent-truncate / overflow branches are observable at all. The
     default fixture name (21 chars) never triggers them. */
  "screens.members.agent-detail.profile.long-machine-name": {
    id: "screens.members.agent-detail.profile.long-machine-name",
    route: "members-agent-detail",
    agentKey: "longMachine",
    tab: "profile",
  },
  /* Batch 2 (task #535 / #259 / #261), oracles fixed by artin on 2026-09-03:
       daemon-only    bare daemon (isComputer false): web version segment is exactly
                      "legacy v0.65.0" next to the separate "Connected" span
                      (machineRunLabel.ts picks daemonVersion for non-computers;
                      #7823 renamed the kind from "daemon" to "legacy")
       no-membership  serverRole omitted (no membership row): role chip hidden
       loading-state  machines not loaded yet: Computer row absent (甲) */
  "screens.members.agent-detail.profile.daemon-only": {
    id: "screens.members.agent-detail.profile.daemon-only",
    route: "members-agent-detail",
    agentKey: "daemonOnly",
    tab: "profile",
  },
  "screens.members.agent-detail.profile.no-membership": {
    id: "screens.members.agent-detail.profile.no-membership",
    route: "members-agent-detail",
    agentKey: "noMembership",
    tab: "profile",
  },
  "screens.members.agent-detail.profile.loading-state": {
    id: "screens.members.agent-detail.profile.loading-state",
    route: "members-agent-detail",
    tab: "profile",
    machinesLoading: true,
  },
  "screens.members.agent-detail.reminders": {
    id: "screens.members.agent-detail.reminders",
    route: "members-agent-detail",
  },
  "screens.members.agent-detail.workspace": {
    id: "screens.members.agent-detail.workspace",
    route: "members-agent-detail",
  },
  "components.members.agent-detail.status.credential-held-sign-in": {
    id: "components.members.agent-detail.status.credential-held-sign-in",
    credentialStatus: "held-sign-in",
  },
  "components.members.agent-detail.status.credential-held-sign-in.dark": {
    id: "components.members.agent-detail.status.credential-held-sign-in.dark",
    credentialStatus: "held-sign-in",
  },
  "components.members.agent-detail.status.credential-own-billing": {
    id: "components.members.agent-detail.status.credential-own-billing",
    credentialStatus: "own-billing",
  },
  "components.members.agent-detail.status.credential-own-billing.dark": {
    id: "components.members.agent-detail.status.credential-own-billing.dark",
    credentialStatus: "own-billing",
  },
  "components.members.agent-detail.status.runtime-error-code-member": {
    id: "components.members.agent-detail.status.runtime-error-code-member",
    runtimeErrorView: "member",
  },
  "components.members.agent-detail.status.runtime-error-code-member.dark": {
    id: "components.members.agent-detail.status.runtime-error-code-member.dark",
    runtimeErrorView: "member",
  },
  "components.members.agent-detail.status.runtime-error-code-manager": {
    id: "components.members.agent-detail.status.runtime-error-code-manager",
    runtimeErrorView: "manager",
  },
  "components.members.agent-detail.status.runtime-error-code-manager.dark": {
    id: "components.members.agent-detail.status.runtime-error-code-manager.dark",
    runtimeErrorView: "manager",
  },
  "components.members.agent-detail.status.credential-member-view": {
    id: "components.members.agent-detail.status.credential-member-view",
    credentialStatus: "member-view",
  },
  "components.members.agent-detail.status.credential-member-view.dark": {
    id: "components.members.agent-detail.status.credential-member-view.dark",
    credentialStatus: "member-view",
  },
  "screens.members.agent-detail.apps": {
    id: "screens.members.agent-detail.apps",
    route: "members-agent-detail",
  },
  "screens.members.agent-detail.activity": {
    id: "screens.members.agent-detail.activity",
    route: "members-agent-detail",
  },
  /* Agent Details with a saved provider connection in use. Exists so the
     provider-connection Select can be MEASURED: it renders only for Built-in
     runtime with the connections feature on and a connection saved, and nothing
     in the default fixture supplies any of that — which is why that control had
     no coverage at all until task #28. */
  "screens.members.agent-detail.runtime-connection": {
    id: "screens.members.agent-detail.runtime-connection",
    route: "members-agent-detail",
  },
  "screens.members.agent-detail.activity.stop-computer": {
    id: "screens.members.agent-detail.activity.stop-computer",
    route: "members-agent-detail",
  },
  "screens.members.agent-detail.activity.stop-user": {
    id: "screens.members.agent-detail.activity.stop-user",
    route: "members-agent-detail",
  },
  "screens.members.human.profile": {
    id: "screens.members.human.profile",
    route: "members-human-detail",
  },
  "components.members.agent-lifecycle-actions": {
    id: "components.members.agent-lifecycle-actions",
  },
  "components.members.avatar-management": {
    id: "components.members.avatar-management",
  },
};

const CREATE_CHANNEL_CASES: Record<string, CreateChannelVisualCase> = {
  "components.home.create-channel.dialog": {
    id: "components.home.create-channel.dialog",
  },
};

type HomeLoadingVisualCase = {
  id: string;
};

// screens.home.loading — the post-sign-in transition (task #372): login has
// succeeded and MainLayout is mounted on the server home route, but the
// channels/DMs/agents/computers fetches are still in flight, so the 390px
// mobile home surface shows the Sidebar skeleton rows instead of loaded lists.
const HOME_LOADING_CASES: Record<string, HomeLoadingVisualCase> = {
  "screens.home.loading": {
    id: "screens.home.loading",
  },
};

// screens.home.channel-list (+ .dark): the whole phone Home root — the
// Sidebar's mobileInline top bar (workspace pill + bell), Saved, Pinned, Joint
// Channels, Channels and Direct Messages, over the MobileTabBar — from the
// `homeChannelList` block of the shared fixtureData.json, which Android reads
// through the generated VisualFixtureData.HomeChannelList. The dark case
// is the same view under `?theme=dark` (its manifest variant prop).
type HomeChannelListVisualCase = {
  id: string;
};

const HOME_CHANNEL_LIST_CASES: Record<string, HomeChannelListVisualCase> = {
  "screens.home.channel-list": { id: "screens.home.channel-list" },
  "screens.home.channel-list.dark": { id: "screens.home.channel-list.dark" },
};

const DIRECT_CASES: Record<string, DirectVisualCase> = {
  "components.tokens.palette": {
    id: "components.tokens.palette",
    kind: "tokens",
  },
  "components.ui.segmented-control.states": {
    id: "components.ui.segmented-control.states",
    kind: "ui-segmented-control",
  },
  "components.ui.button.states": {
    id: "components.ui.button.states",
    kind: "ui-button",
  },
  "components.ui.card.states": {
    id: "components.ui.card.states",
    kind: "ui-card",
  },
  "components.ui.form-field.states": {
    id: "components.ui.form-field.states",
    kind: "ui-form-field",
  },
  "components.ui.textarea.states": {
    id: "components.ui.textarea.states",
    kind: "ui-textarea",
  },
  "components.ui.checkbox.states": {
    id: "components.ui.checkbox.states",
    kind: "ui-checkbox",
  },
  "components.ui.check-marker.states": {
    id: "components.ui.check-marker.states",
    kind: "ui-check-marker",
  },
  "components.ui.typography.specimen": {
    id: "components.ui.typography.specimen",
    kind: "ui-typography-specimen",
  },
  "components.ui.skeleton.states": {
    id: "components.ui.skeleton.states",
    kind: "ui-skeleton",
  },
  "components.ui.slug-input.states": {
    id: "components.ui.slug-input.states",
    kind: "ui-slug-input",
  },
  "components.ui.selection-popover.states": {
    id: "components.ui.selection-popover.states",
    kind: "ui-selection-popover",
  },
  "components.ui.menu-item.states": {
    id: "components.ui.menu-item.states",
    kind: "ui-menu-item",
  },
  "components.ui.select.states": {
    id: "components.ui.select.states",
    kind: "ui-select",
  },
  "components.ui.badge.states": {
    id: "components.ui.badge.states",
    kind: "ui-badge",
  },
  "components.ui.surface-list-item.states": {
    id: "components.ui.surface-list-item.states",
    kind: "ui-surface-list-item",
  },
  "components.ui.avatar-list-row.states": {
    id: "components.ui.avatar-list-row.states",
    kind: "ui-avatar-list-row",
  },
  "components.navigation.tabbar.states": {
    id: "components.navigation.tabbar.states",
    kind: "navigation-tabbar",
  },
  "components.home.titlebar.states": {
    id: "components.home.titlebar.states",
    kind: "home-titlebar",
  },
  "components.thread.header.states": {
    id: "components.thread.header.states",
    kind: "thread-header",
  },
  "components.thread.files.list": {
    id: "components.thread.files.list",
    kind: "thread-files",
  },
  "components.home.notification-center.states": {
    id: "components.home.notification-center.states",
    kind: "notification-center",
  },
  "components.thread.message.row": {
    id: "components.thread.message.row",
    kind: "thread-message",
  },
  "components.thread.message-row.deleted-human": {
    id: "components.thread.message-row.deleted-human",
    kind: "thread-message-deleted-human",
  },
  "components.thread.message-menu.default": {
    id: "components.thread.message-menu.default",
    kind: "thread-message-menu",
  },
  "components.thread.message-menu.task": {
    id: "components.thread.message-menu.task",
    kind: "thread-message-menu",
  },
  "components.thread.message-share.selection": {
    id: "components.thread.message-share.selection",
    kind: "thread-message-share-selection",
  },
  "components.thread.message-share.preview.desktop": {
    id: "components.thread.message-share.preview.desktop",
    kind: "thread-message-share-preview",
  },
  "components.thread.message-share.preview.mobile": {
    id: "components.thread.message-share.preview.mobile",
    kind: "thread-message-share-preview",
  },
  "components.thread.message-row.rich-content": {
    id: "components.thread.message-row.rich-content",
    kind: "thread-message-rich",
  },
  "components.thread.message-row.long-inline-code": {
    id: "components.thread.message-row.long-inline-code",
    kind: "thread-message-long-inline-code",
  },
  "components.thread.message-row.md-link-ref": {
    id: "components.thread.message-row.md-link-ref",
    kind: "thread-message-md-link-ref",
  },
  "components.thread.message-row.md-latest-release": {
    id: "components.thread.message-row.md-latest-release",
    kind: "thread-message-md-latest-release",
  },
  "components.thread.message-row.md-wrap-slice1": {
    id: "components.thread.message-row.md-wrap-slice1",
    kind: "thread-message-md-wrap-slice1",
  },
  "components.thread.message-row.md-wrap-clarify": {
    id: "components.thread.message-row.md-wrap-clarify",
    kind: "thread-message-md-wrap-clarify",
  },
  "components.thread.message-row.md-wrap-adjacent": {
    id: "components.thread.message-row.md-wrap-adjacent",
    kind: "thread-message-md-wrap-adjacent",
  },
  "components.thread.message-row.md-wrap-status606": {
    id: "components.thread.message-row.md-wrap-status606",
    kind: "thread-message-md-wrap-status606",
  },
  "components.thread.message-row.md-wrap-task607": {
    id: "components.thread.message-row.md-wrap-task607",
    kind: "thread-message-md-wrap-task607",
  },
  ...Object.fromEntries(AGENT_READ_LINE_CASE_IDS.map((id) => [id, { id, kind: "thread-message-agent-read-line" as const }])),
  "components.thread.forward-modal": {
    id: "components.thread.forward-modal",
    kind: "thread-forward-modal",
  },
  "components.thread.comment-anchor": {
    id: "components.thread.comment-anchor",
    kind: "thread-comment-anchor",
  },
  "components.channel.settings.panel": {
    id: "components.channel.settings.panel",
    kind: "channel-settings",
  },
  "components.channel.members.add-panel": {
    id: "components.channel.members.add-panel",
    kind: "channel-members",
  },
  "components.home.search.results": {
    id: "components.home.search.results",
    kind: "search",
  },
  "components.home.search.channel-dropdown": {
    id: "components.home.search.channel-dropdown",
    kind: "search",
  },
  "components.home.saved.results": {
    id: "components.home.saved.results",
    kind: "saved-results",
  },
  "components.home.activity.results": {
    id: "components.home.activity.results",
    kind: "activity-results",
  },
  "components.message.external-identity-detail": {
    id: "components.message.external-identity-detail",
    kind: "external-identity-detail",
  },
  "components.tasks.panel.states": {
    id: "components.tasks.panel.states",
    kind: "tasks-panel",
  },
  "components.tasks.status-menu": {
    id: "components.tasks.status-menu",
    kind: "tasks-status-menu",
  },
  "components.tasks.toolbar-row.desktop": {
    id: "components.tasks.toolbar-row.desktop",
    kind: "tasks-toolbar-row",
  },
  "components.tasks.toolbar-row.mid": {
    id: "components.tasks.toolbar-row.mid",
    kind: "tasks-toolbar-row",
  },
};

const SETTINGS_CASES: Record<string, SettingsVisualCase> = {
  "components.settings.root.page": { id: "components.settings.root.page", root: true },
  "components.members.root.page": { id: "components.members.root.page", root: true, rootRoute: "members" },
  "components.home.root.page": { id: "components.home.root.page", root: true, rootRoute: "home" },
  "components.settings.account.page": { id: "components.settings.account.page", tab: "account" },
  "components.settings.account.error-state": { id: "components.settings.account.error-state", tab: "account" },
  "components.settings.server.profile": { id: "components.settings.server.profile", tab: "server" },
  "components.settings.appearance.page": { id: "components.settings.appearance.page", tab: "appearance" },
  "components.settings.notifications.page": { id: "components.settings.notifications.page", tab: "notifications" },
  "components.settings.integrations.page": { id: "components.settings.integrations.page", tab: "integrations" },
  "components.settings.integrations.permission-review": { id: "components.settings.integrations.permission-review", tab: "integrations" },
  "screens.settings.server-danger-modal": { id: "screens.settings.server-danger-modal", tab: "server" },
};

function requestedCaseId(): string {
  const params = new URLSearchParams(window.location.search);
  return params.get("case") || "components.thread.composer.empty";
}

// The capture's mode (`?theme=dark`, light otherwise), applied at the app root
// (main.tsx) so a single ThemeProvider owns the mode class — no nested provider
// whose syncDom effect could race the root's.
export function requestedMode(): "light" | "dark" {
  const params = new URLSearchParams(window.location.search);
  return params.get("theme") === "dark" ? "dark" : "light";
}

// The language of the case's content: the manifest's `locale`, else the
// fixture's. Not the UI language (that follows the case's own `?lang=`).
export function requestedContentLang(): string {
  const id = new URLSearchParams(window.location.search).get("case");
  const visualCase = (sharedCases.cases as Array<{ id: string; locale?: string }>)
    .find((item) => item.id === id);
  return visualCase?.locale || fixtureData.locale.language;
}

function primeVisualStores(caseConfig: ComposerVisualCase) {
  const visualAgents = [
    {
      id: fxCindy.id,
      serverId: fxServer.id,
      name: fxCindy.name,
      displayName: fxCindy.displayName,
      avatarUrl: fxCindy.avatar,
      description: fxCindy.description,
      status: "active" as const,
      serverRole: "member" as const,
      model: fxCindy.model,
      runtime: "codex",
      reasoningEffort: "medium" as const,
      executionMode: "byoc" as const,
      envVars: {},
      machineId: VISUAL_MACHINE_ID,
      sessionId: "session-cindy",
      runtimeProfile: null,
      creatorType: "user" as const,
      creatorId: fxOwner.id,
      creator: null,
      createdAgents: [],
      deletedAt: null,
      createdAt: fxTimes.entityCreatedAtIso,
    },
    {
      id: fxProductUx.id,
      serverId: fxServer.id,
      name: fxProductUx.name,
      displayName: fxProductUx.displayName,
      avatarUrl: fxProductUx.avatar,
      description: fxProductUx.description,
      status: "active" as const,
      serverRole: "member" as const,
      model: fxCindy.model,
      runtime: "codex",
      reasoningEffort: "medium" as const,
      executionMode: "byoc" as const,
      envVars: {},
      machineId: VISUAL_MACHINE_ID,
      sessionId: "session-product-ux",
      runtimeProfile: null,
      creatorType: "user" as const,
      creatorId: fxOwner.id,
      creator: null,
      createdAgents: [],
      deletedAt: null,
      createdAt: fxTimes.entityCreatedAtIso,
    },
    {
      id: fxAndroidDev.id,
      serverId: fxServer.id,
      name: fxAndroidDev.name,
      displayName: fxAndroidDev.displayName,
      avatarUrl: fxCindy.avatar,
      description: fxAndroidDev.description,
      status: "active" as const,
      serverRole: "member" as const,
      model: fxCindy.model,
      runtime: "codex",
      reasoningEffort: "medium" as const,
      executionMode: "byoc" as const,
      envVars: {},
      machineId: VISUAL_MACHINE_ID,
      sessionId: "session-android-dev-4",
      runtimeProfile: null,
      creatorType: "user" as const,
      creatorId: fxOwner.id,
      creator: null,
      createdAgents: [],
      deletedAt: null,
      createdAt: fxTimes.entityCreatedAtIso,
    },
  ];
  useAuthStore.setState({
    initialized: true,
    loading: false,
    user: {
      id: fxOwner.id,
      email: fxOwner.email,
      name: fxOwner.name,
      displayName: fxOwner.displayName,
      description: null,
      avatarUrl: null,
      emailVerified: true,
      preferredLanguage: null,
      displayLanguage: null,
      preferredTimezone: null,
      autoTranslationEnabled: false,
      preferredTranslationMode: "manual" as const,
      preferredTranslationDisplay: "translated" as const,
      preferredTimeFormat: fxOwner.timeFormat as "24h",
      preferredMessageBodyFontSize: null,
      referralSource: null,
      referralSourceOther: null,
      referralSourceSkippedAt: null,
    },
  });
  useServerStore.setState({
    current: {
      id: fxServer.id,
      name: fxServer.name,
      avatarUrl: null,
      slug: fxServer.slug,
      ownerId: fxOwner.id,
      onboardingAgentId: null,
      hideHumansFromMembers: false,
      plan: "free",
      planDowngradedAt: null,
      role: "owner",
      createdAt: fxTimes.entityCreatedAtIso,
    },
    members: [
      {
        userId: fxOwner.id,
        serverId: fxServer.id,
        email: fxOwner.email,
        name: fxOwner.name,
        displayName: fxOwner.displayName,
        description: "Owner",
        avatarUrl: null,
        role: "owner",
        joinedAt: fxTimes.memberJoinedAtIso,
      },
    ],
    loading: false,
  });
  useAgentStore.setState({
    agents: visualAgents,
    loading: false,
  });
  useChannelStore.setState({
    channels: [
      {
        id: VISUAL_CHANNEL_ID,
        serverId: fxServer.id,
        name: fxChannels.design.name,
        description: fxChannels.design.description,
        type: "channel",
        createdAt: fxTimes.entityCreatedAtIso,
        joined: true,
      },
      {
        id: "channel-product",
        serverId: fxServer.id,
        name: "product",
        description: "Release tracking and acceptance",
        type: "channel",
        createdAt: fxTimes.entityCreatedAtIso,
        joined: true,
      },
      {
        id: "channel-android-artifacts",
        serverId: fxServer.id,
        name: fxChannels.androidArtifacts.name,
        description: fxChannels.androidArtifacts.description,
        type: "channel",
        createdAt: fxTimes.entityCreatedAtIso,
        joined: true,
      },
    ],
    dmChannels: [],
    loading: false,
  });
  useMessageStore.setState({
    currentChannelId: VISUAL_CHANNEL_ID,
    currentUserId: fxOwner.id,
    drafts: caseConfig.draft ? { [VISUAL_CHANNEL_ID]: caseConfig.draft } : {},
    ...(caseConfig.pendingMentionActionsAfterSend
      ? {
          sendMessage: async () => ({
            messageId: "visual-pending-mention-message",
            unresolvedMentionHandles: [],
            pendingMentionActions: [
              {
                resolutionId: "visual-pending-mention-resolution",
                messageId: "visual-pending-mention-message",
                targetType: "agent",
                targetHandle: fxAndroidDev.name,
                targetAvatarUrl: fxCindy.avatar,
                reason: "target_not_in_channel",
                availableActions: ["add", "notify"],
                expiresAt: null,
              },
            ],
          }),
        }
      : {}),
  });
}

function primeCreateAgentStores(caseConfig: CreateAgentVisualCase) {
  useAuthStore.setState({
    initialized: true,
    loading: false,
    user: {
      id: fxOwner.id,
      email: fxOwner.email,
      name: fxOwner.name,
      displayName: fxOwner.displayName,
      description: null,
      avatarUrl: null,
      emailVerified: true,
      preferredLanguage: null,
      displayLanguage: null,
      preferredTimezone: null,
      autoTranslationEnabled: false,
      preferredTranslationMode: "manual" as const,
      preferredTranslationDisplay: "translated" as const,
      preferredTimeFormat: fxOwner.timeFormat as "24h",
      preferredMessageBodyFontSize: null,
      referralSource: null,
      referralSourceOther: null,
      referralSourceSkippedAt: null,
    },
  });
  useServerStore.setState({
    current: {
      id: fxServer.id,
      name: fxServer.name,
      avatarUrl: null,
      slug: fxServer.slug,
      ownerId: fxOwner.id,
      onboardingAgentId: null,
      hideHumansFromMembers: false,
      plan: "free",
      planDowngradedAt: null,
      role: "owner",
      createdAt: fxTimes.entityCreatedAtIso,
    },
    members: [],
    loading: false,
    // `atLimit` reads billing first and only falls back to agents.length, so the
    // capacity Banner is seeded here rather than by faking a long agent list.
    billing: caseConfig.atCapacity
      ? {
          plan: "free",
          displayName: "Free",
          serverPlan: "free",
          source: "server" as const,
          capacity: { maxHumans: -1, maxAgents: 3, maxUniversalSeats: -1 },
          usage: { humans: 1, agents: 3, universalSeats: 0 },
          provisioned: { humans: 0, agents: 0, proPackQuantity: 0, trialFreePackQuantity: 0 },
          price: null,
          subscription: null,
          stripeConfigured: false,
          permissions: { canReadBillingSummary: true, canManageBilling: true },
        }
      : null,
  });
  useMachineStore.setState({
    machines: caseConfig.noMachines ? [] : [
      {
        id: VISUAL_MACHINE_ID,
        name: fxPrimaryMachine.name,
        description: null,
        status: "online",
        statusVersion: 1,
        apiKeyPrefix: "slk_vis",
        runtimes: caseConfig.machineRuntimes,
        hostname: null,
        os: "darwin",
        daemonVersion: fxPrimaryMachine.daemonVersion,
        isComputer: true,
        computerVersion: fxPrimaryMachine.computerVersion,
        lastHeartbeat: fxPrimaryMachine.lastHeartbeatIso,
        createdAt: fxTimes.entityCreatedAtIso,
      },
      {
        id: fxStudioMachine.id,
        name: fxStudioMachine.name,
        description: "Design QA and preview capture",
        status: "offline",
        statusVersion: 1,
        apiKeyPrefix: "slk_off",
        runtimes: ["codex"],
        hostname: null,
        os: "linux",
        daemonVersion: fxPrimaryMachine.daemonVersion,
        isComputer: true,
        computerVersion: fxStudioMachine.computerVersion,
        lastHeartbeat: null,
        createdAt: fxTimes.entityCreatedAtIso,
      },
    ],
    loading: false,
  });
  useAgentStore.setState({ agents: [] });
  useChannelStore.setState({
    channels: [
      {
        id: "channel-all",
        serverId: fxServer.id,
        name: "all",
        description: "General",
        type: "channel",
        createdAt: fxTimes.entityCreatedAtIso,
        joined: true,
      },
    ],
    dmChannels: [],
    loading: false,
  });
}

function primeAgentDetailStores(caseId = "") {
  /* The connections feature is read from the serverFeatureFlags STORE, not from
     the evaluate endpoint, so a route mock cannot switch it on — it has to be
     seeded here. Missing this is exactly why the select never rendered under
     test. */
  const wantsProviderConnection = caseId === "screens.members.agent-detail.runtime-connection";
  const fxAgent = fixtureData.agents[AGENT_DETAIL_CASES[caseId]?.agentKey ?? "productUx"];
  const agentMachineId = machineIdForFixtureAgent(fxAgent);
  const agentMachine = [fxPrimaryMachine, fxStudioMachine, fxLongNameMachine, fxDaemonOnlyMachine].find((m) => m.id === agentMachineId) ?? null;
  const machinesLoading = AGENT_DETAIL_CASES[caseId]?.machinesLoading === true;
  if (wantsProviderConnection) {
    setServerFeatureFlagForTests(fxServer.id, PROVIDER_CONNECTIONS_FEATURE_FLAG_KEY, true);
  }
  const visualUser = {
    id: fxOwner.id,
    email: fxOwner.email,
    name: fxOwner.name,
    displayName: fxOwner.displayName,
    description: null,
    avatarUrl: null,
    emailVerified: fxOwner.emailVerified,
    preferredLanguage: null,
    displayLanguage: null,
    preferredTimezone: fxOwner.timezone,
    autoTranslationEnabled: false,
    preferredTranslationMode: "manual" as const,
    preferredTranslationDisplay: "translated" as const,
    preferredTimeFormat: fxOwner.timeFormat as "24h",
    preferredMessageBodyFontSize: null,
    referralSource: "search",
    referralSourceOther: null,
    referralSourceSkippedAt: null,
  };
  const visualAgent = {
    id: fxAgent.id,
    serverId: fxServer.id,
    name: fxAgent.name,
    displayName: fxAgent.displayName,
    avatarUrl: fxAgent.avatar,
    description: fxAgent.description,
    status: "active" as const,
    // task #261: a server member always has a role (server_agent_members.role NOT NULL);
    // the fixture carries it so web, the /api/agents mock, and Android read one value.
    // noMembership carries no serverRole on purpose (no membership row on the wire).
    serverRole: ((fxAgent as { serverRole?: string }).serverRole ?? null) as "member" | "admin" | null,
    model: fxCindy.model,
    runtime: wantsProviderConnection ? "builtin" : "codex",
    reasoningEffort: "medium" as const,
    executionMode: "byoc" as const,
    envVars: {
      RAFT_PROFILE: "product-ux",
      SLOCK_VISUAL_PROVIDER: "react",
    },
    machineId: agentMachineId,
    sessionId: fxAgent.sessionId,
    runtimeProfile: {
      migrationStatus: "stable" as const,
      current: {
        daemonVersion: agentMachine?.daemonVersion ?? fxPrimaryMachine.daemonVersion,
        machineId: agentMachineId,
        machineName: agentMachine?.name ?? null,
        runtime: "codex",
        model: fxCindy.model,
        reasoningEffort: "medium" as const,
        executionMode: "byoc" as const,
        workspaceRef: {
          label: "AndroidStudioProjects/Slock",
          path: "/Users/artin/AndroidStudioProjects/Slock",
          reachable: true,
        },
        observedAt: "2026-06-19T12:28:00.000Z",
      },
    },
    creatorType: "user" as const,
    creatorId: visualUser.id,
    creator: {
      type: "human" as const,
      id: visualUser.id,
      name: visualUser.name,
      displayName: visualUser.displayName,
      avatarUrl: null,
    },
    createdAgents: [
      {
        id: "agent-visual-qa",
        name: "visual-qa",
        displayName: "Visual QA",
        avatarUrl: null,
        runtime: "codex",
        status: "inactive" as const,
      },
    ],
    deletedAt: null,
    createdAt: fxTimes.entityCreatedAtIso,
  };
  // The Model row reads the server's shared model-label catalog first; without
  // it the label waits on the async runtime-models request and a capture that
  // lands mid-flight shows "Loading…" (screens.members.agent-detail.profile in
  // mobile run 40999051412). Seed the catalog the server would serve for the
  // agent's machine so the label is there on the first render. Only that case:
  // loading-state must stay loading, and runtime-connection (builtin) is a
  // runtime the server never sends a catalog for.
  if (caseId === "screens.members.agent-detail.profile" && agentMachineId) {
    useModelLabelCatalogStore.setState((state) => ({
      byServer: {
        ...state.byServer,
        [fxServer.id]: {
          fetchedAt: Date.now(),
          catalog: {
            machines: {
              [agentMachineId]: {
                runtimes: {
                  [visualAgent.runtime]: {
                    models: [{ id: visualAgent.model, label: getModelLabel(visualAgent.runtime, visualAgent.model) }],
                    updatedAt: fxTimes.entityCreatedAtIso,
                  },
                },
              },
            },
          },
        },
      },
    }));
  }
  useAuthStore.setState({
    initialized: true,
    loading: false,
    accessToken: "visual-access-token",
    refreshToken: "visual-refresh-token",
    user: visualUser,
  });
  useServerStore.setState({
    servers: [
      {
        id: fxServer.id,
        name: fxServer.name,
        avatarUrl: null,
        slug: fxServer.slug,
        ownerId: fxOwner.id,
        onboardingAgentId: null,
        hideHumansFromMembers: false,
        plan: "free",
        planDowngradedAt: null,
        role: "owner",
        createdAt: fxTimes.entityCreatedAtIso,
      },
    ],
    current: {
      id: fxServer.id,
      name: fxServer.name,
      avatarUrl: null,
      slug: fxServer.slug,
      ownerId: fxOwner.id,
      onboardingAgentId: null,
      hideHumansFromMembers: false,
      plan: "free",
      planDowngradedAt: null,
      role: "owner",
      createdAt: fxTimes.entityCreatedAtIso,
    },
    members: [
      {
        userId: fxOwner.id,
        serverId: fxServer.id,
        name: fxOwner.name,
        displayName: fxOwner.displayName,
        description: fxOwner.description,
        email: fxOwner.email,
        role: fxOwner.role as "owner",
        avatarUrl: null,
        joinedAt: fxTimes.memberJoinedAtIso,
      },
    ],
    sidebarOrder: {
      channelOrder: [],
      agentOrder: [visualAgent.id],
      dmOrder: [],
      channelSortMode: "manual",
      jointChannelSortMode: "manual",
      dmSortMode: "recent",
      pinnedSortMode: "manual",
      pinned: [{ kind: "agent", id: visualAgent.id }],
      pinnedChannelIds: [],
      pinnedAgentIds: [visualAgent.id],
      pinnedOrder: [visualAgent.id],
      hiddenDmIds: [],
      channelPanelTabOrder: [],
      agentPanelTabOrder: [],
      channelSideLayout: null,
      customSections: [],
      sectionOrder: ["system:pinned", "system:joint", "system:channels", "system:dms"],
      sectionPlacements: [],
      sectionsVersion: 0,
      pinnedVersion: 0,
    },
    loading: false,
  });
  useMachineStore.setState({
    machines: machinesLoading ? [] : [
      {
        id: VISUAL_MACHINE_ID,
        name: fxPrimaryMachine.name,
        description: null,
        status: "online",
        statusVersion: 1,
        apiKeyPrefix: "slk_vis",
        runtimes: ["codex", "claude"],
        hostname: fxPrimaryMachine.hostname,
        os: "darwin",
        daemonVersion: fxPrimaryMachine.daemonVersion,
        isComputer: true,
        computerVersion: fxPrimaryMachine.computerVersion,
        lastHeartbeat: fxPrimaryMachine.lastHeartbeatIso,
        createdAt: fxTimes.entityCreatedAtIso,
      },
      {
        id: fxStudioMachine.id,
        name: fxStudioMachine.name,
        description: "Design QA and preview capture",
        status: "offline",
        statusVersion: 1,
        apiKeyPrefix: "slk_off",
        runtimes: ["codex"],
        hostname: fxStudioMachine.hostname,
        os: "linux",
        daemonVersion: fxPrimaryMachine.daemonVersion,
        isComputer: true,
        computerVersion: fxStudioMachine.computerVersion,
        lastHeartbeat: null,
        createdAt: fxTimes.entityCreatedAtIso,
      },
      {
        id: fxDaemonOnlyMachine.id,
        name: fxDaemonOnlyMachine.name,
        description: "Bare daemon, not a managed Computer (task #535 batch 2)",
        status: "online",
        statusVersion: 1,
        apiKeyPrefix: fxDaemonOnlyMachine.apiKeyPrefix,
        runtimes: ["codex"],
        hostname: fxDaemonOnlyMachine.hostname,
        os: "linux",
        daemonVersion: fxDaemonOnlyMachine.daemonVersion,
        isComputer: false,
        computerVersion: null,
        lastHeartbeat: fxDaemonOnlyMachine.lastHeartbeatIso,
        createdAt: fxTimes.entityCreatedAtIso,
      },
      {
        id: fxLongNameMachine.id,
        name: fxLongNameMachine.name,
        description: "CI capture host with a name that cannot fit one line (task #537)",
        status: "online",
        statusVersion: 1,
        apiKeyPrefix: fxLongNameMachine.apiKeyPrefix,
        runtimes: ["codex"],
        hostname: fxLongNameMachine.hostname,
        os: "darwin",
        daemonVersion: fxLongNameMachine.daemonVersion,
        isComputer: true,
        computerVersion: fxLongNameMachine.computerVersion,
        lastHeartbeat: fxLongNameMachine.lastHeartbeatIso,
        createdAt: fxTimes.entityCreatedAtIso,
      },
    ],
    loading: machinesLoading,
  });
  const stopReasonEntry = caseId === "screens.members.agent-detail.activity.stop-computer"
    ? {
        timestamp: 1781872320000,
        entry: {
          kind: "status" as const,
          activity: "offline" as const,
          activityKind: "offline" as const,
          detail: "Computer stopped",
          detailKind: "stopped" as const,
        },
      }
    : caseId === "screens.members.agent-detail.activity.stop-user"
      ? {
          timestamp: 1781872320000,
          entry: {
            kind: "status" as const,
            activity: "offline" as const,
            activityKind: "offline" as const,
            detail: "Agent stopped by user",
            detailKind: "stopped" as const,
          },
        }
      : null;

  useAgentStore.setState({
    agents: [visualAgent],
    agentActivities: {
      [visualAgent.id]: {
        activity: "working",
        activityDetail: "Capturing deterministic profile state",
        detailKind: "other",
      },
    },
    trajectoryLogs: {
      [visualAgent.id]: [
        {
          timestamp: 1781872080000,
          entry: {
            kind: "status",
            activity: "working",
            activityKind: "working",
            detail: "Capturing deterministic Activity tab state",
            detailKind: "other",
          },
        },
        {
          timestamp: 1781872140000,
          entry: {
            kind: "thinking",
            text: "Comparing React and Android Members Activity screenshots before publishing.",
          },
        },
        {
          timestamp: 1781872200000,
          entry: {
            kind: "tool_start",
            toolName: "shell",
            toolInput: "pnpm --filter @botiverse/raft-visual-testing exec slock-visual diff --case screens.members.agent-detail.activity",
          },
        },
        {
          timestamp: 1781872260000,
          entry: {
            kind: "slock_action",
            title: "Posted status update",
            text: "Reported capture progress in #product:d4870bc3 and kept #225 in review.",
          },
        },
        ...(stopReasonEntry ? [stopReasonEntry] : []),
      ],
    },
    activityLogs: {
      [visualAgent.id]: [
        {
          timestamp: 1781872080000,
          activity: "working",
          detail: "Rebuilt Agent detail visual fixture from current main",
          detailKind: "other",
        },
      ],
    },
  });
  primeCredentialStatus(AGENT_DETAIL_CASES[caseId]?.credentialStatus, visualAgent.id);
  primeRuntimeErrorView(AGENT_DETAIL_CASES[caseId]?.runtimeErrorView, visualAgent.id);
  useChannelStore.setState({
    channels: [],
    dmChannels: [
      {
        id: "dm-agent-product-ux-artin",
        serverId: fxServer.id,
        name: visualAgent.displayName,
        description: fxMessages.dmLastPreview,
        type: "dm",
        peerId: visualAgent.id,
        peerName: visualAgent.displayName,
        createdAt: fxTimes.recentActivityAtIso,
        joined: true,
      },
    ],
    loading: false,
  });
}

const CREDENTIAL_HELD_DETAIL = "Codex CLI is not logged in on this computer. Sign in again, then restart the agent. (Reported by another agent on the same sign-in.)";
const CREDENTIAL_BILLING_DETAIL = "Codex CLI reported that the provider's billing or credit balance is exhausted. Raft stopped retrying because retries cannot succeed until the balance is restored. Messages that were waiting are kept and will be delivered when the agent starts again. Add credits or switch this agent to another model or provider, then restart the agent.";

/** #proj-raft-computer:#48: seed the invalid-credential states over the primed agent. */
function primeCredentialStatus(state: AgentDetailVisualCase["credentialStatus"], agentId: string) {
  if (!state) return;
  const held = state !== "own-billing";
  useAgentStore.setState((store) => ({
    agents: store.agents.map((agent) => agent.id !== agentId ? agent : {
      ...agent,
      lastRuntimeError: held ? null : {
        message: CREDENTIAL_BILLING_DETAIL,
        at: fxTimes.recentActivityAtIso,
        actionRequired: true,
        errorClass: "BillingError" as const,
        errorReason: "billing_exhausted" as const,
        fingerprint: "0123456789abcdef",
        reasonProvenance: "runtime_error_event" as const,
      },
      // A member who did not create it: may restart it, may not see its details.
      ...(state === "member-view" ? { creatorId: fxDesigner.id } : {}),
    }),
    agentActivities: {
      ...store.agentActivities,
      [agentId]: held
        ? { activity: "online" as const, activityDetail: CREDENTIAL_HELD_DETAIL, detailKind: "idle" as const, credentialHold: { reason: "user_reauth" as const } }
        : { activity: "error" as const, activityDetail: CREDENTIAL_BILLING_DETAIL, detailKind: "runtime_error" as const },
    },
  }));
  if (state === "member-view") {
    useServerStore.setState((store) => ({
      servers: store.servers.map((server) => ({ ...server, role: "member" as const })),
      current: store.current ? { ...store.current, role: "member" as const } : store.current,
    }));
  }
}

const RUNTIME_ERROR_SCRUBBED_DETAIL = "429 Too Many Requests: You have hit your usage limit for this billing period (account [redacted]). Try again after the limit resets.";

/** #wg-rbac:#57: seed a usage_limit runtime error the way the server sends it to each viewer. */
function primeRuntimeErrorView(view: AgentDetailVisualCase["runtimeErrorView"], agentId: string) {
  if (!view) return;
  // A member gets the code's fixed English sentence in place of the text; a manager the scrubbed text.
  const text = view === "member" ? RUNTIME_ERROR_CODE_SENTENCES.usage_limit : RUNTIME_ERROR_SCRUBBED_DETAIL;
  useAgentStore.setState((store) => ({
    agents: store.agents.map((agent) => agent.id !== agentId ? agent : {
      ...agent,
      lastRuntimeError: { message: text, code: "usage_limit" as const, at: fxTimes.recentActivityAtIso, actionRequired: false },
      ...(view === "member" ? { creatorId: fxDesigner.id } : {}),
    }),
    agentActivities: {
      ...store.agentActivities,
      [agentId]: { activity: "error" as const, activityDetail: text, detailKind: "runtime_error" as const, errorCode: "usage_limit" as const },
    },
  }));
  if (view === "member") {
    useServerStore.setState((store) => ({
      servers: store.servers.map((server) => ({ ...server, role: "member" as const })),
      current: store.current ? { ...store.current, role: "member" as const } : store.current,
    }));
  }
}

// screens.home.loading (task #372): reuse the signed-in user/server/session
// fixtures from primeAgentDetailStores, then rewind the data stores to the
// moment right after login succeeds — channel/DM/agent/computer lists empty
// and still loading. The playwright spec delays the matching /api list
// endpoints for this case so MainLayout's mount-time fetches stay in flight
// and the primed loading flags keep the Sidebar skeleton rows on screen.
function primeHomeLoadingStores() {
  primeAgentDetailStores();
  useChannelStore.setState({
    channels: [],
    dmChannels: [],
    channelActivity: {},
    loading: true,
    dmsLoading: true,
  });
  useAgentStore.setState({
    agents: [],
    agentActivities: {},
    loading: true,
  });
  useMachineStore.setState({
    machines: [],
    loading: true,
  });
}

// screens.home.channel-list (+ .dark): seed exactly the rows of
// fixtureData.json `homeChannelList` — one server (so the pill carries no
// other-server dot), no activity unread (no Activity tab dot), no live agent
// activity bar, and only the fixture's channels / DMs / agents. The playwright
// spec answers the mount-time loads (inbox, saved, followed threads, unread
// summary) with the same data.
function primeHomeChannelListStores() {
  primeDirectVisualStores();
  const fixture = fixtureData.homeChannelList;
  const server = {
    id: fxServer.id,
    name: fixture.serverName,
    avatarUrl: null,
    slug: fxServer.slug,
    ownerId: fxOwner.id,
    onboardingAgentId: null,
    hideHumansFromMembers: false,
    plan: "free" as const,
    planDowngradedAt: null,
    role: "owner" as const,
    createdAt: fxTimes.entityCreatedAtIso,
  };
  const current = useServerStore.getState();
  useServerStore.setState({
    current: server,
    servers: [server],
    serverUnreadCounts: {},
    sidebarOrder: {
      ...current.sidebarOrder,
      pinned: fixture.pinnedChannelIds.map((id) => ({ kind: "channel" as const, id })),
    },
    loading: false,
  });
  useChannelStore.setState({
    channels: fixture.channels.map((channel) => ({
      id: channel.id,
      serverId: fxServer.id,
      name: channel.name,
      description: null,
      type: channel.type as Channel["type"],
      createdAt: fxTimes.entityCreatedAtIso,
      joined: true,
      activityMuted: channel.muted,
      activityMuteSupported: true,
    })),
    dmChannels: fixture.directMessages.map((dm) => ({
      id: dm.id,
      serverId: fxServer.id,
      name: dm.id,
      description: null,
      type: "dm" as const,
      createdAt: fxTimes.entityCreatedAtIso,
      joined: true,
      peerType: dm.peerType as "agent" | "user",
      peerId: dm.peerId,
      peerName: dm.name,
      peerDisplayName: dm.name,
    })),
    channelActivity: {},
    loading: false,
    dmsLoading: false,
  });
  const agentDms = fixture.directMessages.filter((dm) => dm.peerType === "agent");
  useAgentStore.setState({
    agents: agentDms.map((dm) => ({
      ...visualAgents[0],
      id: dm.peerId,
      name: dm.name,
      displayName: dm.name,
      avatarUrl: null,
      description: null,
      runtime: dm.runtime ?? "",
      sessionId: `session-${dm.peerId}`,
    })),
    agentActivities: Object.fromEntries(agentDms.map((dm) => [
      dm.peerId,
      { activity: dm.activity, activityDetail: dm.activityDetail ?? "", detailKind: "other" },
    ])) as never,
    loading: false,
  });
  const conversations = [...fixture.channels, ...fixture.directMessages];
  useMessageStore.setState({
    currentChannelId: null,
    currentUserId: fxOwner.id,
    unreadCounts: Object.fromEntries(conversations.filter((item) => item.unread > 0).map((item) => [item.id, item.unread])),
    mentionFlags: Object.fromEntries(fixture.channels.filter((channel) => channel.mention).map((channel) => [channel.id, true])),
    newFlags: {},
    drafts: Object.fromEntries(fixture.channels.filter((channel) => channel.draft).map((channel) => [channel.id, "Draft for the roadmap review"])),
    messages: [],
    loading: false,
  });
  useThreadStore.setState({
    followedThreads: homeChannelListFollowedThreads(
      fixture.channels,
      fxOwner.id,
      fxTimes.entityCreatedAtIso,
      fxTimes.recentActivityAtIso,
    ) as never,
  });
  useSavedStore.setState({ total: fixture.savedTotal });
  // No computers: the fixture computers' attention states would light the More
  // tab dot and the Bell's pixel, which Android's Home has no source for here.
  useMachineStore.setState({ machines: [], machineWorkspaces: {}, selectedMachineId: null });
  useInboxStore.setState({
    items: [],
    hasMore: false,
    totalCount: 0,
    totalUnreadCount: fixture.activityUnreadCount,
  });
}

function primeCreateChannelStores() {
  const visualUser = {
    id: fxOwner.id,
    email: fxOwner.email,
    name: fxOwner.name,
    displayName: fxOwner.displayName,
    description: null,
    avatarUrl: null,
    emailVerified: fxOwner.emailVerified,
    preferredLanguage: null,
    displayLanguage: null,
    preferredTimezone: fxOwner.timezone,
    autoTranslationEnabled: false,
    preferredTranslationMode: "manual" as const,
    preferredTranslationDisplay: "translated" as const,
    preferredTimeFormat: fxOwner.timeFormat as "24h",
    preferredMessageBodyFontSize: null,
    referralSource: null,
    referralSourceOther: null,
    referralSourceSkippedAt: null,
  };
  useAuthStore.setState({
    initialized: true,
    loading: false,
    user: visualUser,
  });
  useServerStore.setState({
    current: {
      id: fxServer.id,
      name: fxServer.name,
      avatarUrl: null,
      slug: fxServer.slug,
      ownerId: fxOwner.id,
      onboardingAgentId: null,
      hideHumansFromMembers: false,
      plan: "free",
      planDowngradedAt: null,
      role: "owner",
      createdAt: fxTimes.entityCreatedAtIso,
    },
    members: [
      {
        userId: visualUser.id,
        serverId: fxServer.id,
        name: visualUser.name,
        displayName: visualUser.displayName,
        description: null,
        email: visualUser.email,
        role: "owner",
        avatarUrl: null,
        joinedAt: fxTimes.memberJoinedAtIso,
      },
      {
        userId: fxDesigner.id,
        serverId: fxServer.id,
        name: fxDesigner.name,
        displayName: fxDesigner.displayName,
        description: null,
        email: fxDesigner.email,
        role: "member",
        avatarUrl: null,
        joinedAt: fxTimes.memberJoinedAtIso,
      },
    ],
    loading: false,
  });
  useAgentStore.setState({
    agents: [
      {
        id: fxCindy.id,
        serverId: fxServer.id,
        name: fxCindy.name,
        displayName: fxCindy.displayName,
        avatarUrl: fxCindy.avatar,
        description: fxCindy.description,
        status: "active" as const,
        serverRole: "member" as const,
        model: fxCindy.model,
        runtime: "codex",
        reasoningEffort: "medium" as const,
        executionMode: "byoc" as const,
        envVars: {},
        machineId: VISUAL_MACHINE_ID,
        sessionId: "session-cindy",
        runtimeProfile: null,
        creatorType: "user" as const,
        creatorId: visualUser.id,
        creator: {
          type: "human" as const,
          id: visualUser.id,
          name: visualUser.name,
          displayName: visualUser.displayName,
          avatarUrl: null,
        },
        createdAgents: [],
        deletedAt: null,
        createdAt: fxTimes.entityCreatedAtIso,
      },
      {
        id: "agent-qa",
        serverId: fxServer.id,
        name: "Visual-QA",
        displayName: "Visual QA",
        avatarUrl: "pixel:eye",
        description: "Checks screenshots before release.",
        status: "inactive" as const,
        serverRole: "member" as const,
        model: fxCindy.model,
        runtime: "codex",
        reasoningEffort: "medium" as const,
        executionMode: "byoc" as const,
        envVars: {},
        machineId: VISUAL_MACHINE_ID,
        sessionId: "session-qa",
        runtimeProfile: null,
        creatorType: "user" as const,
        creatorId: visualUser.id,
        creator: {
          type: "human" as const,
          id: visualUser.id,
          name: visualUser.name,
          displayName: visualUser.displayName,
          avatarUrl: null,
        },
        createdAgents: [],
        deletedAt: null,
        createdAt: fxTimes.entityCreatedAtIso,
      },
    ],
  });
  useChannelStore.setState({
    channels: [
      {
        id: "channel-all",
        serverId: fxServer.id,
        name: "all",
        description: "General",
        type: "channel",
        createdAt: fxTimes.entityCreatedAtIso,
        joined: true,
      },
    ],
    dmChannels: [],
    loading: false,
  });
}

const visualUser = {
  id: fxOwner.id,
  email: fxOwner.email,
  name: fxOwner.name,
  displayName: fxOwner.displayName,
  description: null,
  avatarUrl: null,
  emailVerified: fxOwner.emailVerified,
  preferredLanguage: null,
  displayLanguage: null,
  preferredTimezone: fxOwner.timezone,
  autoTranslationEnabled: false,
  preferredTranslationMode: "manual" as const,
  preferredTranslationDisplay: "translated" as const,
  preferredTimeFormat: fxOwner.timeFormat as "24h",
  preferredMessageBodyFontSize: null,
  referralSource: null,
  referralSourceOther: null,
  referralSourceSkippedAt: null,
};

export const visualAgents = [
  {
    id: fxCindy.id,
    serverId: fxServer.id,
    name: fxCindy.name,
    displayName: fxCindy.displayName,
    avatarUrl: fxCindy.avatar,
    description: fxCindy.description,
    status: "active" as const,
    serverRole: "member" as const,
    model: fxCindy.model,
    runtime: "codex",
    reasoningEffort: "medium" as const,
    executionMode: "byoc" as const,
    envVars: {},
    machineId: VISUAL_MACHINE_ID,
    sessionId: "session-cindy",
    runtimeProfile: null,
    creatorType: "user" as const,
    creatorId: visualUser.id,
    creator: {
      type: "human" as const,
      id: visualUser.id,
      name: visualUser.name,
      displayName: visualUser.displayName,
      avatarUrl: null,
    },
    createdAgents: [],
    deletedAt: null,
    createdAt: fxTimes.entityCreatedAtIso,
  },
  {
    id: fxProductUx.id,
    serverId: fxServer.id,
    name: fxProductUx.name,
    displayName: fxProductUx.displayName,
    avatarUrl: fxProductUx.avatar,
    description: fxProductUx.description,
    status: "active" as const,
    serverRole: "member" as const,
    model: fxCindy.model,
    runtime: "codex",
    reasoningEffort: "medium" as const,
    executionMode: "byoc" as const,
    envVars: {},
    machineId: VISUAL_MACHINE_ID,
    sessionId: "session-product-ux",
    runtimeProfile: null,
    creatorType: "user" as const,
    creatorId: visualUser.id,
    creator: {
      type: "human" as const,
      id: visualUser.id,
      name: visualUser.name,
      displayName: visualUser.displayName,
      avatarUrl: null,
    },
    createdAgents: [],
    deletedAt: null,
    createdAt: fxTimes.entityCreatedAtIso,
  },
];

const visualMachines: Machine[] = [
  {
    id: VISUAL_MACHINE_ID,
    name: fxPrimaryMachine.name,
    description: null,
    status: "online",
    statusVersion: 1,
    apiKeyPrefix: "slk_vis",
    runtimes: ["codex", "claude"],
    hostname: fxPrimaryMachine.hostname,
    os: "darwin",
    daemonVersion: fxPrimaryMachine.daemonVersion,
    isComputer: true,
    computerVersion: fxPrimaryMachine.computerVersion,
    computerUpgradeAvailable: true,
    lastHeartbeat: fxPrimaryMachine.lastHeartbeatIso,
    createdAt: fxTimes.entityCreatedAtIso,
  },
  {
    id: fxStudioMachine.id,
    name: fxStudioMachine.name,
    description: "Design QA and preview capture",
    status: "offline",
    statusVersion: 1,
    apiKeyPrefix: "slk_off",
    runtimes: ["codex"],
    hostname: fxStudioMachine.hostname,
    os: "linux",
    daemonVersion: fxPrimaryMachine.daemonVersion,
    isComputer: true,
    computerVersion: fxStudioMachine.computerVersion,
    computerUpgradeAvailable: false,
    lastHeartbeat: null,
    createdAt: fxTimes.entityCreatedAtIso,
  },
];

const visualMembers = [
  {
    userId: visualUser.id,
    serverId: fxServer.id,
    email: visualUser.email,
    name: visualUser.name,
    displayName: visualUser.displayName,
    description: "Owner",
    avatarUrl: null,
    role: "owner" as const,
    joinedAt: fxTimes.memberJoinedAtIso,
  },
  {
    userId: fxDesigner.id,
    serverId: fxServer.id,
    email: fxDesigner.email,
    name: fxDesigner.name,
    displayName: fxDesigner.displayName,
    description: fxDesigner.description,
    avatarUrl: null,
    role: "member" as const,
    joinedAt: fxTimes.memberJoinedAtIso,
  },
];

function primeDirectVisualStores(caseId?: string) {
  useAuthStore.setState({
    initialized: true,
    loading: false,
    user: visualUser,
  });
  useServerStore.setState({
    current: {
      id: fxServer.id,
      name: fxServer.name,
      avatarUrl: null,
      slug: fxServer.slug,
      ownerId: fxOwner.id,
      onboardingAgentId: null,
      hideHumansFromMembers: false,
      plan: "free",
      planDowngradedAt: null,
      role: "owner",
      createdAt: fxTimes.entityCreatedAtIso,
    },
    members: visualMembers,
    loading: false,
  });
  useChannelStore.setState({
    channels: [
      {
        id: fxChannels.design.id,
        serverId: fxServer.id,
        name: fxChannels.design.name,
        description: fxChannels.design.description,
        type: "channel",
        createdAt: fxTimes.entityCreatedAtIso,
        joined: true,
        // The add-member entry is gated on this capability
        // (canUseChannelMemberAction -> hasChannelMemberCapability). Scoped to
        // the one case that clicks it: granting it to every direct case would
        // add an add-member affordance to unrelated channel captures.
        ...(caseId === "components.channel.members.add-panel"
          ? { channelCapabilities: { addChannelMembers: true } }
          : {}),
      },
      {
        id: fxChannels.androidArtifacts.id,
        serverId: fxServer.id,
        name: fxChannels.androidArtifacts.name,
        description: fxChannels.androidArtifacts.description,
        type: "channel",
        createdAt: fxTimes.entityCreatedAtIso,
        joined: true,
      },
    ],
    dmChannels: [],
    loading: false,
    dmsLoading: false,
  });
  useAgentStore.setState({
    agents: visualAgents,
    agentActivities: {
      "agent-cindy": {
        activity: "working",
        activityDetail: "Capturing visual testing baselines",
        detailKind: "other",
      },
      "agent-product-ux": {
        activity: "online",
        activityDetail: "Reviewing screenshots",
        detailKind: "other",
      },
    },
  });
  useMessageStore.setState({
    currentChannelId: fxChannels.design.id,
    currentUserId: fxOwner.id,
  });
  useMachineStore.setState({
    machines: visualMachines,
    latestComputerVersion: fixtureData.latestVersions.computer,
    loading: false,
    selectedMachineId: VISUAL_MACHINE_ID,
    showAddMachine: false,
    machineWorkspaces: {
      [VISUAL_MACHINE_ID]: [
        {
          directoryName: "agent-cindy",
          totalSizeBytes: 134_217_728,
          lastModified: "2026-06-19T12:20:00.000Z",
          fileCount: 428,
          status: "active",
          agentName: fxCindy.displayName,
          agentStatus: "active",
        },
        {
          directoryName: "agent-product-ux",
          totalSizeBytes: 83_886_080,
          lastModified: "2026-06-19T11:45:00.000Z",
          fileCount: 312,
          status: "stopped",
          agentName: fxProductUx.displayName,
          agentStatus: "inactive",
        },
      ],
    },
    machineWorkspacesLoading: {},
    computerOperationProgress: {},
  });
  useSavedStore.setState({
    // Same entries the playwright /api/channels/saved stub serves — the
    // panel's mount-time loadSaved() then reconciles to identical data
    // instead of wiping the list (task #334).
    saved: savedMessagesFixture.saved as never,
    savedIds: new Set(savedMessagesFixture.saved.map((entry) => entry.messageId)),
    loading: false,
    hasMore: savedMessagesFixture.hasMore,
    total: savedMessagesFixture.total,
  });
  useInboxStore.setState({
    // Same rows the playwright /api/channels/inbox stub serves (shared
    // activityResultsFixture.json) — ThreadsInbox's mount-time loadInbox()
    // then reconciles to identical data instead of replacing the list with
    // stub content the Android fixture never shows (task #351).
    items: activityResultsFixture.items as never,
    filter: "all",
    loading: false,
    loadingMore: false,
    hasMore: activityResultsFixture.hasMore,
    totalCount: activityResultsFixture.totalCount,
    totalUnreadCount: activityResultsFixture.totalUnreadCount,
  });
  useTaskStore.setState({
    // Same rows the playwright /api/tasks/server stub serves (shared
    // tasksFixture.json) — TasksPanel's mount-time summary-lane loads
    // (loadActiveTaskSummaries, task #8) then reconcile to identical data
    // instead of wiping the cards (task #353). The stub answers every
    // /api/tasks/server URL (query included) with the same rows and no
    // next_cursor, so each lane commits the fixture rows and reports no
    // further pages.
    serverTasks: tasksFixture.tasks as never,
    serverLoading: false,
    // Channel-scoped task numbers referenced (bare, without a `task #` prefix)
    // by the narrow markdown message-row wrap fixtures (md-wrap-slice1 /
    // md-wrap-clarify / md-wrap-task607). MessageItem's knownTaskNumbers is the
    // union of channel + server tasks, so these make #787 / #31 / #521 / #607
    // chip. The server-mode TasksPanel visual case reads only serverTasks, so
    // these channel tasks never appear in its baseline.
    tasks: [
      { taskNumber: 787 },
      { taskNumber: 31 },
      { taskNumber: 521 },
      { taskNumber: 607 },
      { taskNumber: 606 },
    ] as never,
  });
}

function primeNavigationVisualStores() {
  primeDirectVisualStores();
  // The shared fixture's server (fixtureData.json `server`): the Android
  // provider names it the same, so "On {server}" and other server labels
  // compare like for like.
  useServerStore.setState({
    current: {
      id: fxServer.id,
      name: fxServer.name,
      avatarUrl: null,
      slug: fxServer.slug,
      ownerId: fxOwner.id,
      onboardingAgentId: null,
      hideHumansFromMembers: false,
      plan: "free",
      planDowngradedAt: null,
      role: "owner",
      createdAt: fxTimes.entityCreatedAtIso,
    },
    servers: [
      {
        id: fxServer.id,
        name: fxServer.name,
        avatarUrl: null,
        slug: fxServer.slug,
        ownerId: fxOwner.id,
        onboardingAgentId: null,
        hideHumansFromMembers: false,
        plan: "free",
        planDowngradedAt: null,
        role: "owner",
        createdAt: fxTimes.entityCreatedAtIso,
      },
      {
        id: "visual-alt-server",
        name: "Android Lab",
        avatarUrl: null,
        slug: "android-lab",
        ownerId: fxOwner.id,
        onboardingAgentId: null,
        hideHumansFromMembers: false,
        plan: "free",
        planDowngradedAt: null,
        role: "owner",
        createdAt: fxTimes.entityCreatedAtIso,
      },
    ],
    loading: false,
  });
  useChannelStore.setState({
    channels: [
      {
        id: "channel-home",
        serverId: fxServer.id,
        name: "首页专修",
        description: "Home shell, server badge, and bottom dock polish",
        type: "channel",
        createdAt: fxTimes.entityCreatedAtIso,
        joined: true,
      },
      {
        id: "channel-product",
        serverId: fxServer.id,
        name: "product",
        description: "Visual testing release gates",
        type: "channel",
        createdAt: fxTimes.entityCreatedAtIso,
        joined: true,
      },
    ],
    dmChannels: [],
    loading: false,
  });
  useMessageStore.setState({
    currentChannelId: "channel-home",
    currentUserId: fxOwner.id,
    unreadCounts: {
      "channel-home": 24,
      "channel-product": 2,
    },
    messages: [],
    loading: false,
  });
  useTaskStore.setState({
    tasks: [],
    loading: false,
    currentChannelId: "channel-home",
    serverTasks: [],
    serverLoading: false,
  });
}

// Route-based cases must have the browser URL in place BEFORE BrowserRouter
// mounts: post-mount history.replaceState + synthetic popstate (the previous
// implementation) is not observed by react-router v7, so every screens.*
// route case captured an empty router outlet on clean checkouts.
// primeVisualRoutePath() below runs at module scope, ahead of ReactDOM render.
function useVisualRoute(path: string, caseId: string, extraParams?: Record<string, string>) {
  void caseId;
  void extraParams;
  return window.location.pathname === path;
}

function settingsRootPath(caseConfig: SettingsVisualCase): string {
  const route = caseConfig.rootRoute ?? "settings";
  return route === "home" ? `/s/${fxServer.slug}` : `/s/${fxServer.slug}/${route}`;
}

function visualRoutePathForCase(caseId: string): { path: string; params?: Record<string, string> } | null {
  const agentDetail = AGENT_DETAIL_CASES[caseId];
  if (agentDetail?.route === "members-agent-detail") {
    const agentId = fixtureData.agents[agentDetail.agentKey ?? "productUx"].id;
    return { path: `/s/${fxServer.slug}/agent/${agentId}`, params: { agentTab: agentDetailTab(agentDetail) } };
  }
  if (agentDetail?.route === "members-human-detail") {
    return { path: `/s/${fxServer.slug}/human/${fxOwner.id}` };
  }
  if (isComputersRackCase(caseId)) return { path: COMPUTERS_RACK_CASE_PATH };
  if (isOpenInAppOfferCase(caseId)) return { path: OPEN_IN_APP_OFFER_CASE_PATH };
  if (HOME_LOADING_CASES[caseId] || HOME_CHANNEL_LIST_CASES[caseId]) {
    return { path: `/s/${fxServer.slug}` };
  }
  const direct = DIRECT_CASES[caseId];
  if (direct && (direct.kind === "navigation-tabbar" || direct.kind === "home-titlebar")) {
    return { path: `/s/${fxServer.slug}` };
  }
  const settingsCase = SETTINGS_CASES[caseId];
  if (settingsCase?.root) {
    return { path: settingsRootPath(settingsCase) };
  }
  return null;
}

(function primeVisualRoutePath() {
  if (typeof window === "undefined") return;
  const target = visualRoutePathForCase(requestedCaseId());
  if (!target) return;
  const params = new URLSearchParams(window.location.search);
  for (const [key, value] of Object.entries(target.params || {})) {
    params.set(key, value);
  }
  if (window.location.pathname !== target.path) {
    window.history.replaceState(null, "", `${target.path}?${params.toString()}`);
  }
})();

function primeSettingsVisualStores(caseConfig: SettingsVisualCase) {
  if (caseConfig.root) {
    primeNavigationVisualStores();
    return;
  }

  primeDirectVisualStores();

  const current = useServerStore.getState().current;
  const role = caseConfig.id === "components.settings.billing.no-permission" ? "member" : "owner";
  const plan = caseConfig.id === "components.settings.billing.founder" ? "founder" : "free";
  const planDowngradedAt = caseConfig.id === "components.settings.billing.downgrade"
    ? "2026-06-20T00:00:00.000Z"
    : null;

  useServerStore.setState({
    current: current
      ? {
          ...current,
          role,
          plan,
          planDowngradedAt,
        }
      : current,
    members: visualMembers.map((member) => (
      member.userId === visualUser.id ? { ...member, role } : member
    )),
    usage: {
      agents: caseConfig.id === "components.settings.billing.downgrade" ? 8 : 2,
      machines: caseConfig.id === "components.settings.billing.downgrade" ? 3 : 1,
      channels: caseConfig.id === "components.settings.billing.downgrade" ? 12 : 4,
    },
    loadingUsage: caseConfig.id === "components.settings.billing.loading",
    loadingBilling: caseConfig.id === "components.settings.billing.loading",
    billing: null,
  });
}

type InviteHumanVisualCase = {
  id: string;
  /** Guest is offered only when the server flag is on AND the caller may invite. */
  guestEnabled: boolean;
};

const INVITE_HUMAN_CASES: Record<string, InviteHumanVisualCase> = {
  "components.members.invite-human.per-row-role": {
    id: "components.members.invite-human.per-row-role",
    guestEnabled: true,
  },
  "components.members.invite-human.gate-off": {
    id: "components.members.invite-human.gate-off",
    guestEnabled: false,
  },
};

function InviteHumanVisualCaseView({ caseConfig }: { caseConfig: InviteHumanVisualCase }) {
  useMemo(() => {
    // Owner, so `capabilities.inviteMembers` is true: the Guest control needs
    // both halves, and seeding only the flag would render nothing.
    useServerStore.setState({
      current: {
        id: fxServer.id,
        name: fxServer.name,
        avatarUrl: null,
        slug: fxServer.slug,
        ownerId: fxOwner.id,
        onboardingAgentId: null,
        hideHumansFromMembers: false,
        plan: "free",
        role: "owner",
      },
      billing: null,
      loadBilling: async () => {},
    } as never);
    // Read from the flag STORE rather than the evaluate endpoint, so route
    // mocking cannot switch it on — it has to be seeded.
    setServerFeatureFlagForTests(fxServer.id, SERVER_GUEST_FEATURE_FLAG_KEY, caseConfig.guestEnabled);
  }, [caseConfig.guestEnabled]);

  return (
    <main className="min-h-screen bg-layer-canvas p-0 font-display text-foreground">
      <div data-visual-case={caseConfig.id} style={{ width: 390, height: 844, overflow: "hidden" }}>
        <InviteHumanDialog onClose={noop} surface="sidebar" />
      </div>
    </main>
  );
}

export default function VisualTestingCases() {
  const caseId = requestedCaseId();
  if (caseId === "screens.feedback-sdk.inbox") return <FeedbackSdkTrial />;
  if (caseId === "screens.feedback-sdk.inbox.narrow") return <FeedbackSdkTrial narrow />;
  if (caseId === "screens.feedback-sdk.detail") return <FeedbackSdkTrial detail />;
  if (caseId === "screens.feedback-sdk.detail.narrow") return <FeedbackSdkTrial detail narrow />;
  if ((FILE_VIEWER_CASE_IDS as readonly string[]).includes(caseId)) return <FileViewerCase caseId={caseId} />;
  if ((MESSAGE_CARD_CASE_IDS as readonly string[]).includes(caseId)) return <MessageCardCase caseId={caseId} />;
  if ((ACTION_CARD_CASE_IDS as readonly string[]).includes(caseId)) return <ActionCardCase caseId={caseId as (typeof ACTION_CARD_CASE_IDS)[number]} />;
  if ((ASSISTANT_OTTER_CASE_IDS as readonly string[]).includes(caseId)) return <AssistantOtterCase caseId={caseId} />;
  if ((EXTERNAL_AGENT_CREATE_CASE_IDS as readonly string[]).includes(caseId)) return <ExternalAgentCreateCase caseId={caseId} />;
  if ((EXTERNAL_AGENT_PAGE_CASE_IDS as readonly string[]).includes(caseId)) return <ExternalAgentPageCase caseId={caseId} />;
  if ((AGENT_CONTEXT_VIEW_CASE_IDS as readonly string[]).includes(caseId)) return <AgentContextViewCase caseId={caseId} />;
  if ((AGENT_ACTIVITY_LOG_CASE_IDS as readonly string[]).includes(caseId)) return <AgentActivityLogCase caseId={caseId} />;
  if ((ARTIFACT_FILTER_CASE_IDS as readonly string[]).includes(caseId)) return <ArtifactFilterCase caseId={caseId} />;
  if (isComputersRackCase(caseId)) return <ComputersRackCase caseId={caseId} primeShell={primeNavigationVisualStores} />;
  if (isOpenInAppOfferCase(caseId)) return <OpenInAppOfferCase caseId={caseId} primeShell={primeNavigationVisualStores} />;

  const authCase = AUTH_CASES[caseId];
  if (authCase) return <AuthVisualCaseView caseConfig={authCase} />;

  const agentDetailCase = AGENT_DETAIL_CASES[caseId];
  if (agentDetailCase) return <AgentDetailVisualCaseView caseConfig={agentDetailCase} />;

  const createAgentCase = CREATE_AGENT_CASES[caseId];
  if (createAgentCase) return <CreateAgentVisualCaseView caseConfig={createAgentCase} />;

  const createChannelCase = CREATE_CHANNEL_CASES[caseId];
  if (createChannelCase) return <CreateChannelVisualCaseView caseConfig={createChannelCase} />;

  const inviteHumanCase = INVITE_HUMAN_CASES[caseId];
  if (inviteHumanCase) return <InviteHumanVisualCaseView caseConfig={inviteHumanCase} />;

  const homeLoadingCase = HOME_LOADING_CASES[caseId];
  if (homeLoadingCase) return <HomeLoadingRouteVisualCaseView caseConfig={homeLoadingCase} />;

  const homeChannelListCase = HOME_CHANNEL_LIST_CASES[caseId];
  if (homeChannelListCase) return <HomeChannelListVisualCaseView caseConfig={homeChannelListCase} />;


  const directCase = DIRECT_CASES[caseId];
  if (directCase) return <DirectVisualCaseView caseConfig={directCase} />;

  const settingsCase = SETTINGS_CASES[caseId];
  if (settingsCase) return <SettingsVisualCaseView caseConfig={settingsCase} />;

  const composerCase = COMPOSER_CASES[caseId];
  if (composerCase) return <ComposerVisualCaseView caseConfig={composerCase} />;

  // No silent fallback: an unregistered case id must fail its capture loudly.
  // Body/viewport-selector cases would otherwise screenshot the composer and
  // publish a plausible-looking but wrong baseline.
  return (
    <main className="min-h-screen bg-layer-canvas p-6 font-display text-foreground">
      <div data-visual-unknown-case={caseId} className="rounded-container border-[1.5px] border-line-strong p-4 text-callout font-bold">
        Unknown visual case id: {caseId}. Register it in VisualTestingCases.tsx before capturing.
      </div>
    </main>
  );
}

function ComposerVisualCaseView({ caseConfig }: { caseConfig: ComposerVisualCase }) {
  useMemo(() => primeVisualStores(caseConfig), [caseConfig]);

  return (
    <main className="min-h-screen bg-layer-canvas p-0 font-display text-foreground">
      <div
        data-visual-case={caseConfig.visualCaseAttr}
        data-visual-case-id={caseConfig.id}
        style={{
          width: caseConfig.width || 342,
          // Unset height follows the composer: a fixed 100px cut the two-line
          // draft's bottom row, and after the As Task click scrolled the
          // clipped box, its top border too.
          height: caseConfig.height ?? "auto",
          overflow: "hidden",
          paddingTop: caseConfig.composerOffsetTop || 0,
          boxSizing: "border-box",
        }}
      >
        <MessageInput
          channelId={VISUAL_CHANNEL_ID}
          channelName={fxChannels.design.name}
          showTaskButton
          placeholder={caseConfig.placeholder}
          activationBanner={caseConfig.activationPlacement === "mobile"
            ? <NotificationActivationBanner placement="mobile" composerChannelId={VISUAL_CHANNEL_ID} />
            : undefined}
          {...(caseConfig.pendingMentionActionsAfterSend ? {} : { onSendOverride: asyncNoop })}
        />
        {caseConfig.activationPlacement === "desktop" ? (
          <NotificationActivationBanner placement="desktop" composerChannelId={VISUAL_CHANNEL_ID} />
        ) : null}
      </div>
    </main>
  );
}

function AuthVisualCaseView({ caseConfig }: { caseConfig: AuthVisualCase }) {
  useMemo(() => {
    useAuthStore.setState({
      initialized: true,
      loading: false,
      user: null,
    });
  }, []);
  return (
    <main className="min-h-screen bg-layer-canvas p-0 font-display text-foreground">
      <div data-visual-case={caseConfig.id} style={{ width: 390, height: 844, overflow: "hidden" }}>
        <LoginPage onSwitchToRegister={noop} onForgotPassword={noop} />
      </div>
    </main>
  );
}

function AgentDetailVisualCaseView({ caseConfig }: { caseConfig: AgentDetailVisualCase }) {
  useMemo(() => primeAgentDetailStores(caseConfig.id), [caseConfig.id]);
  if (caseConfig.route === "members-agent-detail") {
    return <MembersAgentDetailRouteVisualCaseView caseConfig={caseConfig} />;
  }
  if (caseConfig.route === "members-human-detail") {
    return <MembersHumanDetailRouteVisualCaseView caseConfig={caseConfig} />;
  }
  const agent = useAgentStore.getState().agents[0];
  return (
    <main className="min-h-screen bg-layer-canvas p-0 font-display text-foreground">
      <div data-visual-case={caseConfig.id} style={{ width: 390, height: 844, overflow: "hidden" }}>
        <AgentDetailPanel agent={agent} onClose={noop} />
      </div>
    </main>
  );
}

function MembersHumanDetailRouteVisualCaseView({ caseConfig }: { caseConfig: AgentDetailVisualCase }) {
  const ready = useVisualRoute(`/s/${fxServer.slug}/human/${fxOwner.id}`, caseConfig.id);
  if (!ready) return null;

  return (
    <main className="min-h-screen bg-layer-canvas p-0 font-display text-foreground">
      <div data-visual-case={caseConfig.id} style={{ width: 390, height: 844, overflow: "hidden" }}>
        <Routes>
          <Route path="/s/:serverSlug/*" element={<MainLayout />} />
        </Routes>
      </div>
    </main>
  );
}

function HomeLoadingRouteVisualCaseView({ caseConfig }: { caseConfig: HomeLoadingVisualCase }) {
  useMemo(() => primeHomeLoadingStores(), []);
  const ready = useVisualRoute(`/s/${fxServer.slug}`, caseConfig.id);
  if (!ready) return null;

  // The wrapper is a flex column so MainLayout's `flex-1` root stretches to
  // the full 844px viewport — that keeps the MobileTabBar pinned to the
  // bottom edge exactly like the real App.tsx shell does post-login.
  return (
    <main className="min-h-screen bg-layer-canvas p-0 font-display text-foreground">
      <div
        data-visual-case={caseConfig.id}
        style={{ width: 390, height: 844, overflow: "hidden", display: "flex", flexDirection: "column" }}
      >
        <Routes>
          <Route path="/s/:serverSlug/*" element={<MainLayout />} />
        </Routes>
      </div>
    </main>
  );
}

function HomeChannelListVisualCaseView({ caseConfig }: { caseConfig: HomeChannelListVisualCase }) {
  useMemo(() => primeHomeChannelListStores(), []);
  const ready = useVisualRoute(`/s/${fxServer.slug}`, caseConfig.id);
  if (!ready) return null;

  // MainLayout's phone root without its route fetches: the Sidebar's
  // mobileInline list fills the column and the MobileTabBar sits in flow at
  // the bottom, as on a 390x844 phone.
  return (
    <main className="min-h-screen bg-layer-canvas p-0 font-display text-foreground">
      <div
        data-visual-case={caseConfig.id}
        style={{ width: 390, height: 844, overflow: "hidden", display: "flex", flexDirection: "column", background: "var(--layer-canvas)" }}
      >
        <div className="flex min-h-0 flex-1">
          <Sidebar mobileInline />
        </div>
        <MobileTabBar />
      </div>
    </main>
  );
}

/** Tab for an agent-detail case: explicit `tab` wins; otherwise the last id
    segment, with the two historical remaps (activity.* variants, apps -> integrations). */
function agentDetailTab(caseConfig: AgentDetailVisualCase): string {
  if (caseConfig.tab) return caseConfig.tab;
  const rawTab = caseConfig.id.split(".").pop() || "profile";
  return caseConfig.id.includes(".activity.") ? "activity" : rawTab === "apps" ? "integrations" : rawTab;
}

function MembersAgentDetailRouteVisualCaseView({ caseConfig }: { caseConfig: AgentDetailVisualCase }) {
  const tab = agentDetailTab(caseConfig);
  const agentId = fixtureData.agents[caseConfig.agentKey ?? "productUx"].id;
  const routeParams = useMemo(() => ({ agentTab: tab }), [tab]);
  const ready = useVisualRoute(`/s/${fxServer.slug}/agent/${agentId}`, caseConfig.id, routeParams);
  if (!ready) return null;

  return (
    <main className="min-h-screen bg-layer-canvas p-0 font-display text-foreground">
      <div data-visual-case={caseConfig.id} style={{ width: 390, height: 844, overflow: "hidden" }}>
        <Routes>
          <Route path="/s/:serverSlug/*" element={<MainLayout />} />
        </Routes>
      </div>
    </main>
  );
}

function CreateAgentVisualCaseView({ caseConfig }: { caseConfig: CreateAgentVisualCase }) {
  useMemo(() => primeCreateAgentStores(caseConfig), [caseConfig]);
  return (
    <main className="min-h-screen bg-layer-canvas p-0 font-display text-foreground">
      <div data-visual-case={caseConfig.id} data-visual-runtime={caseConfig.runtime}>
        <CreateAgentDialog
          defaultMachineId={VISUAL_MACHINE_ID}
          prefilledName={caseConfig.empty ? "" : (caseConfig.prefilledName ?? "Product-QA-Bot")}
          prefilledDescription={caseConfig.empty ? "" : "Watches release screenshots and reports visual regressions before merge."}
          onClose={noop}
        />
      </div>
    </main>
  );
}

const PREFILLED_CHANNEL_AGENT_IDS = ["agent-cindy"];
const PREFILLED_CHANNEL_HUMAN_IDS = ["visual-human-designer"];

function CreateChannelVisualCaseView({ caseConfig }: { caseConfig: CreateChannelVisualCase }) {
  useMemo(() => primeCreateChannelStores(), []);
  return (
    <main className="min-h-screen bg-layer-canvas p-0 font-display text-foreground">
      <div data-visual-case={caseConfig.id} style={{ width: 390, height: 844, overflow: "hidden" }}>
        {/* Values follow the manifest variant prefilled-members: name
            android-artifacts, description "Build reports, screenshots,
            release blockers", selected human+agent (task #334). */}
        <CreateChannelDialog
          prefilledName="android-artifacts"
          prefilledDescription="Build reports, screenshots, release blockers"
          prefilledVisibility="public"
          prefilledAgentIds={PREFILLED_CHANNEL_AGENT_IDS}
          prefilledHumanIds={PREFILLED_CHANNEL_HUMAN_IDS}
          onClose={noop}
        />
      </div>
    </main>
  );
}

const THREAD_FILES_CHANNEL: Channel = {
  id: VISUAL_CHANNEL_ID,
  serverId: fxServer.id,
  name: fxChannels.design.name,
  description: fxChannels.design.description,
  type: "channel",
  createdAt: fxTimes.entityCreatedAtIso,
  joined: true,
};

const EXTERNAL_IDENTITY_PROFILE: ComponentProps<typeof ExternalIdentityDetailPanel>["profile"] = {
  projectionId: "visual-external-projection",
  provider: "slack",
  appRegistrationId: "visual-slack-app",
  installId: "visual-slack-install",
  workspaceId: "opaque-workspace-id-not-rendered",
  workspaceName: "Acme Product Studio",
  externalActorId: "visual-slack-actor",
  externalConversationId: "visual-slack-channel",
  externalMessageId: "visual-slack-message",
  displayName: "Ada Lovelace",
  actorKind: "human",
  avatarUrl: null,
  avatarDigest: null,
  actorProjectionRevision: 1,
};

const SKELETON_LINE_WIDTHS = ["w-32", "w-20"];

// raft-ui Skeleton pulses (animate-pulse), so an unfrozen capture lands on a
// random opacity and the fill reads 243, 244 or 245 run to run. Hold it at
// full opacity so the case measures only shape and fill.
const STILL_SKELETON_CSS =
  "[data-visual-case='components.ui.skeleton.states'] [data-slot='skeleton'] { animation: none; }";

const SELECTION_POPOVER_OPTIONS = [
  { key: "design", checked: true, label: "design", onClick: noop, reserveLeadingSlot: true },
  { key: "visual-testing", checked: false, label: "visual-testing", onClick: noop, reserveLeadingSlot: true },
  { key: "archive", checked: false, label: "archived channel", disabled: true, onClick: noop, reserveLeadingSlot: true },
  { key: "none", checked: false, label: "No channel", italic: true, onClick: noop, reserveLeadingSlot: true },
];

const COMMENT_ANCHOR_PARENT_MESSAGE = { id: "msg-anchor-1", channelId: fxChannels.design.id };

const COMMENT_ANCHOR_PENDING_ANCHOR = {
  type: "md-section",
  data: {
    headingId: "agent-tabs-full-page-review",
    headingTitle: "agent-tabs-full-page-review.mp4",
  },
} as const;

export type VisualMessageRowFixture = {
  message: Message;
  /** Fixture channel the body's `#channel` tags resolve against, on top of the primed store channels. */
  extraChannel?: Channel;
  /** Agent-authored rows render with the first fixture agent as preview sender. */
  previewSenderAgent?: boolean;
  hideThreadActions?: boolean;
  threadSummary?: ThreadSummary;
  linkedTask?: Task;
  /** A thread reply: the thread's parent conversation and message. */
  parentChannelId?: string;
  parentMessageId?: string;
  /** Agent read progress (AgentReadLineCases): the line under your latest message, and the faces. */
  showAgentReadStatus?: boolean;
  agentReadFaces?: boolean;
};

const THREAD_MESSAGE: Message = {
  id: "msg-agent-reply",
  channelId: fxChannels.design.id,
  senderType: "agent",
  senderId: fxCindy.id,
  senderName: fxCindy.displayName,
  content: fxMessages.threadDefault,
  threadId: "thread-msg-agent-reply",
  createdAt: "2026-06-22T02:30:00.000Z",
  reactions: [{ emoji: "👍", count: 2, reactorIds: [fxOwner.id], reactorNames: [fxOwner.name] }],
};

// Manifest variant agent-message-task-replies: replyCount 5 + taskNumber 10
// → the replies footer chip and task badge must render, so thread actions
// stay enabled here (task #334).
const THREAD_MESSAGE_FIXTURE: VisualMessageRowFixture = {
  message: THREAD_MESSAGE,
  previewSenderAgent: true,
  threadSummary: {
    threadChannelId: "thread-msg-agent-reply",
    replyCount: 5,
    lastReplyAt: "2026-06-22T03:05:00.000Z",
    participantIds: [fxOwner.id, fxCindy.id],
    unreadCount: 2,
    firstUnreadMessageId: "msg-agent-reply-4",
  },
  linkedTask: {
    id: "msg-agent-reply",
    messageId: "msg-agent-reply",
    channelId: fxChannels.design.id,
    channelName: fxChannels.design.name,
    channelType: "channel",
    taskNumber: 10,
    title: fxMessages.threadDefault,
    status: "in_progress",
    claimedByType: "agent",
    claimedById: fxCindy.id,
    claimedByName: fxCindy.displayName,
    createdById: fxOwner.id,
    createdAt: "2026-06-22T02:30:00.000Z",
  } as never,
};

const THREAD_MESSAGE_DELETED_HUMAN: Message = {
  id: "msg-deleted-human",
  channelId: fxChannels.design.id,
  senderType: "user",
  senderId: "visual-human-deleted",
  senderName: "Former Teammate",
  senderDescription: "Guest",
  senderMembershipStatus: "removed",
  content: fxMessages.threadDeletedHuman,
  threadId: "thread-msg-deleted-human",
  createdAt: "2026-06-22T03:10:00.000Z",
  reactions: [{ emoji: "👍", count: 1, reactorIds: [fxOwner.id], reactorNames: [fxOwner.name] }],
};

const THREAD_MESSAGE_DELETED_HUMAN_FIXTURE: VisualMessageRowFixture = {
  message: THREAD_MESSAGE_DELETED_HUMAN,
  hideThreadActions: true,
};

function threadMessageMenuFixture(isTaskVariant: boolean): VisualMessageRowFixture {
  const message: Message = {
    id: isTaskVariant ? "msg-menu-task" : "msg-menu-default",
    channelId: fxChannels.design.id,
    senderType: "agent",
    senderId: fxCindy.id,
    senderName: fxCindy.displayName,
    content: isTaskVariant
      ? "Task conversion follow-up for #design: capture the grouped menu before publish."
      : fxMessages.threadDefault,
    threadId: isTaskVariant ? "thread-msg-menu-task" : "thread-msg-menu-default",
    createdAt: "2026-06-22T02:30:00.000Z",
    reactions: [{ emoji: "👍", count: 2, reactorIds: [fxOwner.id], reactorNames: [fxOwner.name] }],
  };
  const linkedTask: Task | undefined = isTaskVariant
    ? {
        id: "task-menu-246",
        messageId: message.id,
        channelId: fxChannels.design.id,
        channelName: fxChannels.design.name,
        channelType: "channel",
        taskNumber: 246,
        title: "Message context menu visual coverage",
        status: "in_progress",
        claimedByType: "agent",
        claimedById: fxCindy.id,
        claimedByName: fxCindy.displayName,
        claimedAt: "2026-06-22T02:31:00.000Z",
        completedAt: null,
        createdById: fxOwner.id,
        createdByType: "user",
        createdByName: fxOwner.name,
        createdAt: "2026-06-22T02:30:00.000Z",
        updatedAt: "2026-06-22T02:31:00.000Z",
      }
    : undefined;
  return {
    message,
    previewSenderAgent: true,
    threadSummary: {
      threadChannelId: message.threadId || "thread-msg-menu-default",
      replyCount: 3,
      participantIds: [fxCindy.id, fxOwner.id],
      unreadCount: 0,
      firstUnreadMessageId: null,
      lastReplyAt: "2026-06-22T02:35:00.000Z",
    },
    linkedTask,
  };
}

const THREAD_MESSAGE_MENU_FIXTURE = threadMessageMenuFixture(false);
const THREAD_MESSAGE_MENU_TASK_FIXTURE = threadMessageMenuFixture(true);

const THREAD_MESSAGE_RICH: Message = {
  id: "msg-rich-visual",
  channelId: fxChannels.design.id,
  senderType: "agent",
  senderId: fxCindy.id,
  senderName: fxCindy.displayName,
  content:
    "Rich fixture for #design: @artin please compare the Android capture against task #222 before publishing. Keep https://raft.build/visual-testing in the body so markdown links and long wrapping stay covered.",
  mentions: [{ type: "user", id: fxOwner.id, name: fxOwner.name }],
  threadId: "thread-msg-rich-visual",
  createdAt: "2026-06-22T15:30:00.000Z",
  attachments: [
    {
      id: "att-visual-spec",
      filename: "visual-parity-notes.pdf",
      mimeType: "application/pdf",
      sizeBytes: 188416,
      commentCount: 3,
    },
    {
      id: "att-thread-preview",
      filename: "thread-screen-preview.html",
      mimeType: "text/html",
      sizeBytes: 32768,
    },
  ],
  reactions: [{ emoji: "👍", count: 3, reactorIds: [fxOwner.id], reactorNames: [fxOwner.name] }],
};

const THREAD_MESSAGE_RICH_TASK: Task = {
  id: "task-222",
  messageId: "msg-rich-visual",
  channelId: fxChannels.design.id,
  channelName: fxChannels.design.name,
  channelType: "channel",
  taskNumber: 222,
  title: "Thread screens + rich message row fixture",
  status: "in_progress",
  claimedByType: "agent",
  claimedById: fxCindy.id,
  claimedByName: fxCindy.displayName,
  claimedAt: "2026-06-22T15:30:00.000Z",
  completedAt: null,
  createdById: fxOwner.id,
  createdByType: "user",
  createdByName: fxOwner.name,
  createdAt: "2026-06-22T15:28:00.000Z",
  updatedAt: "2026-06-22T15:30:00.000Z",
};

const THREAD_MESSAGE_RICH_FIXTURE: VisualMessageRowFixture = {
  message: THREAD_MESSAGE_RICH,
  previewSenderAgent: true,
  threadSummary: {
    threadChannelId: "thread-msg-rich-visual",
    replyCount: 7,
    participantIds: [fxCindy.id, fxOwner.id],
    unreadCount: 2,
    firstUnreadMessageId: "reply-rich-2",
    lastReplyAt: "2026-06-22T15:32:00.000Z",
  },
  linkedTask: THREAD_MESSAGE_RICH_TASK,
};

// React pair for the Android shared `long_inline_code` thread fixture
// (ThreadPage.kt / captureThreadMessageRowLongInlineCode, task #400): the
// body mirrors the Android payload byte-for-byte so the diff isolates
// inline-code chip styling and char-level long-code wrapping (#58/#228)
// instead of fixture drift.
const THREAD_MESSAGE_LONG_INLINE_CODE: Message = {
  id: "msg_long_inline_code_visual",
  channelId: "channel-markdown",
  senderType: "agent",
  senderId: fxCindy.id,
  senderName: fxCindy.displayName,
  content:
    "Plain text baseline before bold.\n\n" +
    "Normal: regular markdown bold sample abcdefg 123.\n\n" +
    "**Bold: regular markdown bold sample abcdefg 123.**\n\n" +
    "Normal CN: 中文粗体 对照样本 123.\n\n" +
    "**粗体 Bold: 中文粗体 markdown bold sample 123.**\n\n" +
    "Tag chip coverage: mention @artin, channel #markdown专修, " +
    "thread #markdown专修:692d9e88, tasks task #42 and task #43.\n\n" +
    "Ordinary mention regression: @KMP-专家 #520 Phase 5: delete remaining ConversationSummary launch compatibility helpers.\n\n" +
    "Short code should stay compact: `CODE_SPAN`, `raft.build.markdown.inlineCode`, `go test ./...`, and `git commit -s`.\n\n" +
    "Long path should wrap inline without ellipsis: `reply/channel-markdown/msg-inline-visual/composer-draft-scroll-realtime-read-receipt/owner-key-consumes-thread-route-identity-only/without-source-thread-fallback/max-width-wrap-proof-alpha-beta-gamma-delta-epsilon-zeta-eta-theta-iota-kappa-lambda-mu`.\n\n" +
    "Command should wrap with the same yellow fill and black frame: `./gradlew :shared:testDebugUnitTest --tests build.raft.app.markdown.SlockMarkdownTest --tests build.raft.app.visual.KmpVisualScreenshotCaptureTest.captureThreadMessageRowLongInlineCode`.\n\n" +
    "> Quote block keeps normal markdown flow beside inline `code` and Slock tags.\n\n" +
    "- Link: https://raft.build/visual-testing\n" +
    "- File: `compose/shared/src/commonMain/kotlin/build/raft/app/markdown/SlockMarkdown.kt`",
  mentions: [{ type: "user", id: fxOwner.id, name: fxOwner.name }],
  threadId: "thread-msg-long-inline-code-visual",
  createdAt: "2026-06-25T05:55:00.000Z",
  attachments: [
    {
      id: "att-markdown-fixture",
      filename: "standard-markdown-fixture.md",
      mimeType: "text/markdown",
      sizeBytes: 6144,
    },
  ],
  reactions: [
    { emoji: "👍", count: 3, reactorIds: [fxOwner.id], reactorNames: [fxOwner.name] },
    { emoji: "✅", count: 1, reactorIds: [fxCindy.id], reactorNames: [fxCindy.displayName] },
  ],
};

const THREAD_MESSAGE_LONG_INLINE_CODE_TASK: Task = {
  id: "task_42",
  messageId: "msg_long_inline_code_visual",
  channelId: "channel-markdown",
  channelName: "markdown",
  channelType: "channel",
  taskNumber: 42,
  title: "Markdown inline code uses standard CODE_SPAN renderer",
  status: "in_review",
  claimedByType: "agent",
  claimedById: fxCindy.id,
  claimedByName: fxCindy.displayName,
  claimedAt: "2026-06-25T05:55:00.000Z",
  completedAt: null,
  createdById: fxOwner.id,
  createdByType: "user",
  createdByName: fxOwner.name,
  createdAt: "2026-06-25T05:50:00.000Z",
  updatedAt: "2026-06-25T05:55:00.000Z",
};

// The Android fixture registers "markdown专修" via knownMarkdownChannelNames
// so the #channel / #channel:shortid tags chip; mirror that by extending the
// store channels with the fixture channel.
const MARKDOWN_FIXTURE_CHANNEL: Channel = {
  id: "channel-markdown",
  name: "markdown专修",
  description: "Markdown parity fixtures",
  type: "channel",
  createdAt: "2026-06-18T00:00:00.000Z",
};

const THREAD_MESSAGE_LONG_INLINE_CODE_FIXTURE: VisualMessageRowFixture = {
  message: THREAD_MESSAGE_LONG_INLINE_CODE,
  extraChannel: MARKDOWN_FIXTURE_CHANNEL,
  previewSenderAgent: true,
  threadSummary: {
    threadChannelId: "thread-msg-long-inline-code-visual",
    replyCount: 4,
    participantIds: [fxCindy.id, fxOwner.id],
    unreadCount: 1,
    firstUnreadMessageId: "reply_long_inline_code_1",
    lastReplyAt: "2026-06-25T05:57:00.000Z",
  },
  linkedTask: THREAD_MESSAGE_LONG_INLINE_CODE_TASK,
};

// React pair for the Android shared `md_link_ref` thread fixture
// (ThreadPage.kt / captureThreadMessageRowMdLinkRef, task #519): body
// mirrors the Android payload byte-for-byte. Guards the Raft dialect
// contract from task #517: refs inside a Markdown link label/destination
// stay part of that one blue external link; only standalone refs outside
// links become chips.
const THREAD_MESSAGE_MD_LINK_REF: Message = {
  id: "msg_md_link_ref_visual",
  channelId: "channel-visual-testing",
  senderType: "agent",
  senderId: fxCindy.id,
  senderName: fxCindy.displayName,
  content:
    "Review [#1487 feat(search): pin entities from long-press and channel settings](https://github.com/botiverse/mobile/pull/1487) then follow task #1487.\n\n" +
    "Channel ref in label: [notes in #visual-testing](https://raft.build/visual-testing) and outside #visual-testing.\n\n" +
    "Mention in label: [ping @artin](https://raft.build/mentions) and outside @artin.",
  mentions: [{ type: "user", id: fxOwner.id, name: fxOwner.name }],
  threadId: "thread-msg-md-link-ref-visual",
  createdAt: "2026-07-25T08:20:00.000Z",
};

const THREAD_MESSAGE_MD_LINK_REF_TASK: Task = {
  id: "task_1487",
  messageId: "msg_md_link_ref_visual",
  channelId: "channel-visual-testing",
  channelName: "visual-testing",
  channelType: "channel",
  taskNumber: 1487,
  title: "feat(search): pin entities from long-press and channel settings",
  status: "in_review",
  claimedByType: "agent",
  claimedById: fxCindy.id,
  claimedByName: fxCindy.displayName,
  claimedAt: "2026-07-25T08:00:00.000Z",
  completedAt: null,
  createdById: fxOwner.id,
  createdByType: "user",
  createdByName: fxOwner.name,
  createdAt: "2026-07-25T07:50:00.000Z",
  updatedAt: "2026-07-25T08:20:00.000Z",
};

const VISUAL_TESTING_FIXTURE_CHANNEL: Channel = {
  id: "channel-visual-testing",
  name: "visual-testing",
  description: "Visual parity fixtures",
  type: "channel",
  createdAt: "2026-06-18T00:00:00.000Z",
};

const THREAD_MESSAGE_MD_LINK_REF_FIXTURE: VisualMessageRowFixture = {
  message: THREAD_MESSAGE_MD_LINK_REF,
  extraChannel: VISUAL_TESTING_FIXTURE_CHANNEL,
  previewSenderAgent: true,
  linkedTask: THREAD_MESSAGE_MD_LINK_REF_TASK,
};

// Exact mixed-markdown specimen requested by artin (task #502). The body
// mirrors the shared KMP `md_latest_release` fixture byte-for-byte so the
// provider diff covers a leading horizontal rule, Chinese prose, bold,
// inline-code angle-bracket placeholders, and a plain PR reference.
const THREAD_MESSAGE_MD_LATEST_RELEASE: Message = {
  id: "msg_md_latest_release_visual",
  channelId: "channel-markdown",
  senderType: "agent",
  senderId: fxCindy.id,
  senderName: fxCindy.displayName,
  content:
    "---\n\n" +
    "明白，是我理解错了。你要的是一个**不需要先创建 share token 的稳定 latest release landing page**，" +
    "类似 `/apps/<app>/latest`，打开永远展示当前最新版并可下载；不是让某条 `/share/<token>` 变成 rolling。\n\n" +
    "我撤掉 PR #318 这套 rolling-share 设计，改做 app latest landing page，并复用现有 share 页的版本信息/下载体验。",
  mentions: [],
  threadId: "thread-msg-md-latest-release-visual",
  createdAt: "2026-07-19T13:03:00.000Z",
};

const THREAD_MESSAGE_MD_LATEST_RELEASE_FIXTURE: VisualMessageRowFixture = {
  message: THREAD_MESSAGE_MD_LATEST_RELEASE,
  previewSenderAgent: true,
};

// Narrow (260px) markdown wrap net: the body mirrors the Android shared
// `md_wrap_slice1` thread fixture byte-for-byte so the diff isolates the
// inline-box line-wrap bug where a channel/task chip wraps to the next
// line. Synthetic mentions, channel, task, and body content keep this public
// fixture free of real collaboration metadata.
const THREAD_MESSAGE_MD_WRAP_SLICE1: Message = {
  id: "msg_md_wrap_slice1_visual",
  channelId: "channel-markdown",
  senderType: "agent",
  senderId: "synthetic-visual-bot",
  senderName: "Visual Bot",
  content:
    "**Synthetic slice is ready** — this message is generated for visual testing only.\n\n" +
    "- The synthetic CI job **passed** after a repeat check (`demo-retry-check`), and Android/OHOS host/shared checks are all green.\n" +
    "- **Synthetic merge record**: an automated test identity completed the sample merge; no production release is involved.\n" +
    "- Feature flag `demo_sync_v1` **stays off by default**; enabling it records only local demo state and remains invisible to users.\n" +
    "- The **data-flow sample** stays in the fixture for cross-platform rendering comparison in #demo-visual-testing.\n\n" +
    "**Sample data is ready.** Next, @DemoUser can compare the synthetic envelope in task #101 and continue the cross-platform check without importing real collaboration content.",
  mentions: [
    { type: "user", id: "synthetic-demo-user", name: "DemoUser" },
  ],
  threadId: "thread-msg-md-wrap-slice1-visual",
  createdAt: "2026-07-13T05:55:00.000Z",
};

const RECONCILE_FIXTURE_CHANNEL: Channel = {
  id: "channel-demo-visual-testing",
  name: "demo-visual-testing",
  description: "Synthetic visual fixture comparison",
  type: "channel",
  createdAt: "2026-06-18T00:00:00.000Z",
};

const THREAD_MESSAGE_MD_WRAP_SLICE1_FIXTURE: VisualMessageRowFixture = {
  message: THREAD_MESSAGE_MD_WRAP_SLICE1,
  extraChannel: RECONCILE_FIXTURE_CHANNEL,
  previewSenderAgent: true,
};

// Narrow (260px) markdown wrap net mirroring the Android shared
// `md_wrap_clarify` thread fixture byte-for-byte. Mention
// @Android-Developer-4 and tasks #31 / #521 (bare + `task #521`) all chip.
const THREAD_MESSAGE_MD_WRAP_CLARIFY: Message = {
  id: "msg_md_wrap_clarify_visual",
  channelId: "channel-markdown",
  senderType: "agent",
  senderId: fxCindy.id,
  senderName: fxCindy.displayName,
  content:
    "另外帮一个澄清避免混淆：#31（read-state→Activity，我的）和 @Android-Developer-4 的 **task #521**（`message:new`→Activity 即时新增，artin 原话\"新消息来了 activity 没刷新\"）是两个不同 gap，不是重复——Codex 早前建议的\"#521 判重关闭\"是把两者混了，AD4 已更正。#31 复用 versioned read-state fact，#521 是 SharedActivityStore 缺 message:new realtime，两条链路各修各的。",
  mentions: [{ type: "agent", id: fxAndroidDev.id, name: fxAndroidDev.name }],
  threadId: "thread-msg-md-wrap-clarify-visual",
  createdAt: "2026-07-13T05:56:00.000Z",
};

const THREAD_MESSAGE_MD_WRAP_CLARIFY_FIXTURE: VisualMessageRowFixture = {
  message: THREAD_MESSAGE_MD_WRAP_CLARIFY,
  previewSenderAgent: true,
};

// Adjacent-chip acceptance case (task #60): '#31 / #521' as two separate
// chips on ONE line with a plain slash between (spaced + compact pairs),
// plus #607 / #对话流专修 tail-glyph controls. Standard 390px width so
// nothing wraps. Body mirrors the Android md_wrap_adjacent fixture
// byte-for-byte.
const THREAD_MESSAGE_MD_WRAP_ADJACENT: Message = {
  id: "msg_md_wrap_adjacent_visual",
  channelId: "channel-markdown",
  senderType: "agent",
  senderId: fxCindy.id,
  senderName: fxCindy.displayName,
  content:
    "对照：#31 / #521 两块同行。\n\n紧凑：#31/#521。\n\n尾宽对照：task #607 与 #对话流专修。",
  mentions: [],
  threadId: "thread-msg-md-wrap-adjacent-visual",
  createdAt: "2026-07-13T05:56:00.000Z",
};

const CONVERSATION_FLOW_FIXTURE_CHANNEL: Channel = {
  id: "channel-conversation-flow",
  name: "对话流专修",
  description: "Conversation stream fixes",
  type: "channel",
  createdAt: "2026-06-18T00:00:00.000Z",
};

const THREAD_MESSAGE_MD_WRAP_ADJACENT_FIXTURE: VisualMessageRowFixture = {
  message: THREAD_MESSAGE_MD_WRAP_ADJACENT,
  extraChannel: CONVERSATION_FLOW_FIXTURE_CHANNEL,
  previewSenderAgent: true,
};

// Agent-status markdown specimen (artin-requested): thread-ref chip
// (#对话流专修:661a12bf), short + 64-hex inline codes, task #606 chip,
// bare PR #785 with NO entity (must stay plain), backtick #/@, @artin.
// Body mirrors the Android md_wrap_status606 fixture byte-for-byte.
const THREAD_MESSAGE_MD_WRAP_STATUS606: Message = {
  id: "msg_md_wrap_status606_visual",
  channelId: "channel-markdown",
  senderType: "agent",
  senderId: fxCindy.id,
  senderName: fxCindy.displayName,
  content:
    "Task #606 新真机基线已就绪：PR #785 exact `0e5a82b02` Alpha 已附在 #对话流专修:661a12bf，SHA-256 `db01c5e5b91f3696bfda64edde2fc31b3a40ffe9b508813d651a6de735e8a85b`。这是 process-owned decoded auth-session snapshot 根修包，不是日志抑制包；`8a5e542f4` 作废。\n\n等待 @artin 验普通导航/滚动及 `#/@` suggestion。若仍卡，以新 Hands 对比 auth durable cold-read 次数和 traversal/layout/draw；task #606 保持 In Progress，PR 不合。",
  mentions: [{ type: "user", id: fxOwner.id, name: fxOwner.name }],
  threadId: "thread-msg-md-wrap-status606-visual",
  createdAt: "2026-07-13T11:25:00.000Z",
};

const THREAD_MESSAGE_MD_WRAP_STATUS606_FIXTURE: VisualMessageRowFixture = {
  message: THREAD_MESSAGE_MD_WRAP_STATUS606,
  extraChannel: CONVERSATION_FLOW_FIXTURE_CHANNEL,
  previewSenderAgent: true,
};

// Narrow (260px) markdown wrap net mirroring the Android shared
// `md_wrap_task607` thread fixture byte-for-byte. Mentions
// (@artin @Android-Developer-2), channel #对话流专修, and task #607 chip.
const THREAD_MESSAGE_MD_WRAP_TASK607: Message = {
  id: "msg_md_wrap_task607_visual",
  channelId: "channel-markdown",
  senderType: "agent",
  senderId: fxCindy.id,
  senderName: fxCindy.displayName,
  content:
    "@artin 建好了：**task #607**（#对话流专修，我已 claim）——slice-1 那个 mapper→network.sync 解耦 follow-up。scope + @Android-Developer-2 的 A/B 设计选择（接受耦合 vs observer-routed 重构）我贴在 task thread 了。AD2 定 A 我 close 成 by-design，定 B 我实现。V2 那条独立、等赵定信封。",
  mentions: [
    { type: "user", id: fxOwner.id, name: fxOwner.name },
    { type: "agent", id: "agent-android-dev-2", name: "Android-Developer-2" },
  ],
  threadId: "thread-msg-md-wrap-task607-visual",
  createdAt: "2026-07-13T05:57:00.000Z",
};

const THREAD_MESSAGE_MD_WRAP_TASK607_FIXTURE: VisualMessageRowFixture = {
  message: THREAD_MESSAGE_MD_WRAP_TASK607,
  extraChannel: CONVERSATION_FLOW_FIXTURE_CHANNEL,
  previewSenderAgent: true,
};

export const VISUAL_MENTION_MAP = buildMentionMap(visualAgents, visualMembers);

const FORWARD_DESIGN_CHANNEL: Channel = {
  id: "channel-design",
  name: "design",
  description: "Product and UI decisions",
  type: "channel",
  createdAt: "2026-06-18T00:00:00.000Z",
  joined: true,
};

const FORWARD_ANDROID_CHANNEL: Channel = {
  id: "channel-android",
  name: "android-artifacts",
  description: "Builds and screenshots",
  type: "channel",
  createdAt: "2026-06-18T00:00:00.000Z",
  joined: true,
};

const FORWARD_ARTIN_DM: Channel = {
  id: "dm-artin",
  name: "artin",
  description: null,
  type: "dm",
  createdAt: "2026-06-18T00:00:00.000Z",
};

const FORWARD_CINDY_DM: Channel = {
  id: "dm-cindy",
  name: "Cindy",
  description: null,
  type: "dm",
  createdAt: "2026-06-18T00:00:00.000Z",
};

const FORWARD_SOURCE_MESSAGE: Message = {
  id: "msg-forward-source",
  channelId: FORWARD_DESIGN_CHANNEL.id,
  senderType: "user",
  senderId: fxOwner.id,
  senderName: fxOwner.name,
  content: "Let's forward this to the right place.",
  threadId: "thread-forward-source",
  createdAt: "2026-06-25T05:55:00.000Z",
};

const FORWARD_SOURCE_MESSAGES: Message[] = [
  FORWARD_SOURCE_MESSAGE,
  { ...FORWARD_SOURCE_MESSAGE, id: "msg-forward-source-2", content: "Second forwarded message." },
];

// React reference for the Android Forward target modal
// (ThreadForwardTargetModal / captureThreadForwardModal, task #560): same
// seeded destinations so the diff isolates the real react↔android structure.
function ThreadForwardModalVisualCaseView({ caseConfig }: { caseConfig: DirectVisualCase }) {
  useMemo(() => {
    useChannelStore.setState({
      channels: [FORWARD_DESIGN_CHANNEL, FORWARD_ANDROID_CHANNEL],
      dmChannels: [FORWARD_ARTIN_DM, FORWARD_CINDY_DM],
    });
  }, []);

  return (
    <main className="min-h-screen bg-layer-canvas p-0 font-display text-foreground">
      <div data-visual-case={caseConfig.id} style={{ width: 390, height: 844, overflow: "hidden" }}>
        <ForwardComposerDialog
          sourceMessages={FORWARD_SOURCE_MESSAGES}
          sourceChannel={FORWARD_DESIGN_CHANNEL}
          onClose={noop}
          onSent={noop}
        />
      </div>
    </main>
  );
}

function DirectVisualCaseView({ caseConfig }: { caseConfig: DirectVisualCase }) {
  useMemo(() => primeDirectVisualStores(caseConfig.id), [caseConfig.id]);

  if (caseConfig.kind === "navigation-tabbar") {
    return <NavigationTabbarVisualCaseView caseConfig={caseConfig} />;
  }

  if (caseConfig.kind === "home-titlebar") {
    return <HomeTitlebarVisualCaseView caseConfig={caseConfig} />;
  }

  if (caseConfig.kind === "thread-header") {
    return <ThreadHeaderVisualCaseView caseConfig={caseConfig} />;
  }

  if (caseConfig.kind === "thread-files") {
    return (
      <main className="min-h-screen bg-layer-canvas p-0 font-display text-foreground">
        <div data-visual-case={caseConfig.id} style={{ width: 390, height: 360, overflow: "hidden" }}>
          <ChannelFilesPanel channel={THREAD_FILES_CHANNEL} />
        </div>
      </main>
    );
  }

  if (caseConfig.kind === "external-identity-detail") {
    return (
      <main className="min-h-screen bg-layer-sidebar p-6 font-display text-foreground">
        <div
          data-visual-case={caseConfig.id}
          className="flex h-[640px] w-[380px] flex-col overflow-hidden border border-line-seam bg-layer-canvas"
        >
          <ExternalIdentityDetailPanel
            profile={EXTERNAL_IDENTITY_PROFILE}
            onClose={noop}
          />
        </div>
      </main>
    );
  }

  if (caseConfig.kind === "saved-results") {
    return (
      <main className="min-h-screen bg-layer-canvas p-0 font-display text-foreground">
        <div data-visual-case={caseConfig.id} style={{ width: 342, height: 620, overflow: "hidden" }}>
          <SavedPanel />
        </div>
      </main>
    );
  }

  if (caseConfig.kind === "activity-results") {
    return (
      <main className="min-h-screen bg-layer-canvas p-0 font-display text-foreground">
        <div data-visual-case={caseConfig.id} style={{ width: 342, height: 620, overflow: "hidden" }}>
          <ThreadsInbox />
        </div>
      </main>
    );
  }

  if (caseConfig.kind === "tasks-panel") {
    // Server-mode TasksPanel (list view on this 390 viewport) in a
    // content-sized wrapper — fixed heights clipped element crops before
    // (tasks #351/#353). Task rows come from shared tasksFixture.json.
    return (
      <main className="min-h-screen bg-layer-canvas p-0 font-display text-foreground">
        <div data-visual-case={caseConfig.id} style={{ width: 390, background: "var(--layer-canvas)" }}>
          <TasksPanel />
        </div>
      </main>
    );
  }

  if (caseConfig.kind === "tasks-toolbar-row") {
    // Server-mode TasksPanel at a desktop width, or as wide as the page's column
    // in an 820px window (`.mid`) (#proj-workspace:dc3c9fc9), so
    // packages/visual-testing/tests/toolbarRowAlignment.spec.ts can measure its
    // toolbar row beside the Artifacts one (ArtifactFilterCases' toolbar-row cases).
    return (
      <main className="min-h-screen bg-layer-canvas p-0 font-display text-foreground">
        <div data-visual-case={caseConfig.id} style={{ width: caseConfig.id.endsWith(".mid") ? 771 : 1100, background: "var(--layer-canvas)" }}>
          <TasksPanel />
        </div>
      </main>
    );
  }

  if (caseConfig.kind === "tasks-status-menu") {
    // InlineBadgeEditor (the status chip menu TaskCard opens) supports a
    // controlled `open`, so the menu renders open statically. Its dropdown
    // portals to document.body fixed-positioned below the trigger; the
    // wrapper is tall enough that the open menu paints inside the element
    // crop — same containment approach as the composer suggestion cases
    // (task #353).
    return (
      <main className="min-h-screen bg-layer-canvas p-0 font-display text-foreground">
        <div
          data-visual-case={caseConfig.id}
          style={{
            width: 342,
            height: 260,
            boxSizing: "border-box",
            background: "var(--layer-canvas)",
            padding: "16px",
          }}
        >
          <InlineBadgeEditor
            displayValue={EN_MESSAGES[STATUS_STYLES.in_progress.labelId]}
            selectedId="in_progress"
            options={TASK_STATUS_MENU_OPTIONS}
            onSelect={noop}
            open
            onToggle={noop}
            badgeStatus="in-progress"
            badgeClassName=""
            dropdownMinWidth="min-w-[140px]"
            dropdownAlign="left"
            dropdownTestId="task-status-menu"
          />
        </div>
      </main>
    );
  }

  if (caseConfig.kind === "tokens") {
    return (
      <main className="min-h-screen bg-layer-canvas p-0 font-display text-foreground">
        <div data-visual-case={caseConfig.id} style={{ width: 342, height: 620, overflow: "hidden" }}>
          <PaletteAuditPage />
        </div>
      </main>
    );
  }

  if (caseConfig.kind === "ui-segmented-control") {
    return (
      <main className="min-h-screen bg-layer-canvas p-0 font-display text-foreground">
        <div
          data-visual-case={caseConfig.id}
          style={{
            width: 342,
            minHeight: 96,
            boxSizing: "border-box",
            overflow: "hidden",
            background: "var(--layer-canvas)",
            padding: "16px",
          }}
        >
          <SegmentedControl value="mentions" aria-label="Inbox filter visual fixture" onValueChange={noop}>
            <SegmentedControlItem value="all" data-testid="visual-segment-all">
              <SegmentedControlLabel>All</SegmentedControlLabel>
              <SegmentedControlCount>24</SegmentedControlCount>
            </SegmentedControlItem>
            <SegmentedControlItem value="mentions" data-testid="visual-segment-mentions">
              <SegmentedControlLabel>Mentions</SegmentedControlLabel>
              <SegmentedControlCount>3</SegmentedControlCount>
            </SegmentedControlItem>
            <SegmentedControlItem value="unread" data-testid="visual-segment-unread">
              <SegmentedControlLabel>Unread</SegmentedControlLabel>
              <SegmentedControlCount>9</SegmentedControlCount>
            </SegmentedControlItem>
          </SegmentedControl>
        </div>
      </main>
    );
  }

  if (caseConfig.kind === "ui-button") {
    return (
      <main className="min-h-screen bg-layer-canvas p-0 font-display text-foreground">
        <div
          data-visual-case={caseConfig.id}
          style={{
            width: 342,
            height: 150,
            boxSizing: "border-box",
            overflow: "hidden",
            background: "var(--layer-canvas)",
            padding: "16px",
          }}
        >
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-3">
              <Button size="md" variant="outline">Save</Button>
              <Button size="md" variant="primary">Sync</Button>
              <Button size="md" variant="accent">Delete</Button>
            </div>
            <div className="flex items-center gap-3">
              <Button size="md" variant="information">Add</Button>
              <Button size="md" variant="success">Continue</Button>
              <Button size="md" variant="muted" disabled>Disabled</Button>
            </div>
          </div>
        </div>
      </main>
    );
  }

  if (caseConfig.kind === "ui-card") {
    return (
      <main className="min-h-screen bg-layer-canvas p-0 font-display text-foreground">
        <div
          data-visual-case={caseConfig.id}
          style={{
            width: 342,
            height: 190,
            boxSizing: "border-box",
            overflow: "hidden",
            background: "var(--layer-canvas)",
            padding: "16px",
          }}
        >
          <div
            className="rounded-container border border-line-hairline bg-layer-card text-foreground"
            style={{ width: 310, boxSizing: "border-box", padding: "14px" }}
          >
            <div className="flex flex-col gap-2">
              <div className="font-semibold" style={{ fontSize: 16, lineHeight: "20px" }}>
                Channel settings
              </div>
              <div
                className="text-foreground-muted"
                style={{ fontSize: 12, lineHeight: "16px" }}
              >
                Control who can post and how the channel appears to members.
              </div>
              <Button size="md" variant="primary">Save changes</Button>
            </div>
          </div>
        </div>
      </main>
    );
  }

  if (caseConfig.kind === "ui-form-field") {
    return (
      <main className="min-h-screen bg-layer-canvas p-0 font-display text-foreground">
        {/* Fixed 342x296 frame (capture-contract, XiShi run 30837350660): 296px contains all
            three states + bottom padding and matches the Android UI_FORM_FIELD_CROP so both
            registers capture the same comparable extent. The old fixed 274px was too short (it
            clipped the error row); content-sized gave React/Android different PNG heights. */}
        <div
          data-visual-case={caseConfig.id}
          style={{
            width: 342,
            height: 296,
            boxSizing: "border-box",
            overflow: "hidden",
            background: "var(--layer-canvas)",
            padding: "16px",
          }}
        >
          <div className="flex flex-col gap-3">
            <FormField label="Email" required htmlFor="visual-email">
              <Input id="visual-email" value="cindy@slock.ai" readOnly />
            </FormField>
            <FormField label="Description" optional hint="Shown in channel discovery.">
              <Input value="Visual parity fixture" readOnly />
            </FormField>
            <FormField label="Server Name" size="compact" error="Name is required">
              <Input data-invalid value="" readOnly />
            </FormField>
          </div>
        </div>
      </main>
    );
  }

  if (caseConfig.kind === "ui-textarea") {
    return (
      <main className="min-h-screen bg-layer-canvas p-0 font-display text-foreground">
        {/* Fixed 342x252 frame (capture-contract, XiShi source-derived H=252dp): the old 240px
            dropped the 2nd textarea's error row on iOS. 252 matches the Android UI_TEXTAREA_CROP
            so both providers + both registers capture the same extent with all rows + padding. */}
        <div
          data-visual-case={caseConfig.id}
          style={{
            width: 342,
            height: 252,
            boxSizing: "border-box",
            overflow: "hidden",
            background: "var(--layer-canvas)",
            padding: "16px",
          }}
        >
          <div className="flex flex-col gap-4">
            <Textarea
              value="This agreement copy is too long for the configured limit."
              readOnly
              rows={2}
              maxLength={40}
              aria-invalid
              aria-describedby="visual-prejoin-error"
            />
            <div className="flex items-start justify-between gap-3">
              <p id="visual-prejoin-error" role="alert" className="text-caption font-semibold text-danger-strong">
                Agreement body must be shorter.
              </p>
              <TextareaCounter value="This agreement copy is too long for the configured limit." limit={40} />
            </div>
          </div>
        </div>
      </main>
    );
  }

  if (caseConfig.kind === "ui-checkbox") {
    return (
      <main className="min-h-screen bg-layer-canvas p-0 font-display text-foreground">
        <div
          data-visual-case={caseConfig.id}
          style={{
            width: 342,
            height: 132,
            boxSizing: "border-box",
            overflow: "hidden",
            background: "var(--layer-canvas)",
            padding: "16px",
          }}
        >
          <div className="flex flex-col gap-3 text-sm font-bold">
            <label className="flex items-center gap-2">
              <Checkbox checked readOnly />
              <span>As Task selected</span>
            </label>
            <label className="flex items-center gap-2">
              <Checkbox checked={false} readOnly />
              <span>Permission row unchecked</span>
            </label>
            <label className="flex items-center gap-2 opacity-60">
              <Checkbox checked disabled />
              <span>Disabled checked</span>
            </label>
          </div>
        </div>
      </main>
    );
  }

  if (caseConfig.kind === "ui-check-marker") {
    return (
      <main className="min-h-screen bg-layer-canvas p-0 font-display text-foreground">
        <div
          data-visual-case={caseConfig.id}
          style={{
            width: 342,
            height: 112,
            boxSizing: "border-box",
            overflow: "hidden",
            background: "var(--layer-canvas)",
            padding: "16px",
          }}
        >
          <div className="flex flex-col gap-3 text-sm font-bold">
            <div className="flex items-center gap-3">
              <CheckboxIndicator checked />
              <span>Square checked</span>
            </div>
            <div className="flex items-center gap-3">
              <CheckboxIndicator checked={false} />
              <span>Square unchecked</span>
            </div>
            <div className="flex items-center gap-3">
              <CheckboxIndicator checked shape="circle" />
              <span>Circle yellow</span>
            </div>
          </div>
        </div>
      </main>
    );
  }

  if (caseConfig.kind === "ui-typography-specimen") {
    // artin 2026-11-02: the app's type reads heavier than the web's. Every raft-ui text style,
    // and the body face at 400 / 500 / 600 / 700, one line each (Latin, digits, Han); the
    // Android fixture (UiTypographySpecimenVisualContent) draws the same lines in the same order.
    const lines: Array<[string, string]> = [
      ["Headline 17", "text-headline"],
      ["Body 16 400", "text-body font-normal"],
      ["Body 16 500", "text-body font-medium"],
      ["Body 16 600", "text-body font-semibold"],
      ["Body 16 700", "text-body font-bold"],
      ["Subhead 15", "text-subhead"],
      ["Callout 14", "text-callout"],
      ["Footnote 13", "text-footnote"],
      ["Caption 12 500", "text-caption"],
      ["Label 11 600", "text-label"],
      ["Mono meta 12", "font-mono text-mono-meta"],
      ["Mono code 13", "font-mono text-mono-code"],
    ];
    return (
      <main className="min-h-screen bg-layer-canvas p-0 font-sans text-foreground">
        <div
          data-visual-case={caseConfig.id}
          style={{
            width: 342,
            height: 300,
            boxSizing: "border-box",
            overflow: "hidden",
            background: "var(--layer-canvas)",
            padding: "16px",
          }}
        >
          {lines.map(([label, className]) => (
            <div key={label} className={`whitespace-nowrap ${className}`}>{label} 排版 Aa 0123</div>
          ))}
        </div>
      </main>
    );
  }

  if (caseConfig.kind === "ui-skeleton") {
    return (
      <main className="min-h-screen bg-layer-canvas p-0 font-display text-foreground">
        <div
          data-visual-case={caseConfig.id}
          style={{
            width: 342,
            height: 150,
            boxSizing: "border-box",
            overflow: "hidden",
            background: "var(--layer-canvas)",
            padding: "16px",
          }}
        >
          <style>{STILL_SKELETON_CSS}</style>
          <div className="flex flex-col gap-3">
            <SkeletonRow avatar avatarClassName="size-5" className="gap-3" lineWidths={SKELETON_LINE_WIDTHS} />
            <Skeleton variant="block" className="h-12 w-full" />
            <div className="flex items-center gap-3">
              <Skeleton variant="block" className="size-8" />
              <Skeleton variant="line" className="w-40" />
            </div>
          </div>
        </div>
      </main>
    );
  }

  if (caseConfig.kind === "ui-slug-input") {
    return (
      <main className="min-h-screen bg-layer-canvas p-0 font-display text-foreground">
        <div
          data-visual-case={caseConfig.id}
          style={{
            width: 342,
            height: 122,
            boxSizing: "border-box",
            overflow: "hidden",
            background: "var(--layer-canvas)",
            padding: "16px",
          }}
        >
          <div className="flex flex-col gap-4">
            <SlugInput value="design-lab" readOnly />
            <SlugInput value="partner-workspace" readOnly className="opacity-60" />
          </div>
        </div>
      </main>
    );
  }

  if (caseConfig.kind === "ui-selection-popover") {
    return (
      <main className="min-h-screen bg-layer-canvas p-0 font-display text-foreground">
        <div
          data-visual-case={caseConfig.id}
          style={{
            width: 342,
            height: 252,
            boxSizing: "border-box",
            overflow: "hidden",
            background: "var(--layer-canvas)",
            padding: "16px",
          }}
        >
          {/* The bare panel: `SelectionPopover` positions itself and must sit
              inside a raft-ui <Popover>; this case places the list itself. */}
          <SelectionPopoverPanel
            title="Channels"
            showClear
            onClear={noop}
            searchable
            search="des"
            onSearchChange={noop}
            searchPlaceholder="Search channels"
            className="w-full overflow-hidden rounded-container border border-line-seam bg-layer-popover shadow-float"
            options={SELECTION_POPOVER_OPTIONS}
          />
        </div>
      </main>
    );
  }

  if (caseConfig.kind === "ui-menu-item") {
    return (
      <main className="min-h-screen bg-layer-canvas p-0 font-display text-foreground">
        {/* Content-sized: a fixed height clipped the divider/disabled rows out
            of the element crop (task #351). */}
        <div
          data-visual-case={caseConfig.id}
          style={{
            width: 342,
            boxSizing: "border-box",
            background: "var(--layer-canvas)",
            padding: "16px",
          }}
        >
          <div className="w-full overflow-hidden rounded-container border border-line-seam bg-layer-popover shadow-float">
            <MenuItem trailing={<span className="font-mono text-mono-meta text-foreground-hint">⌘K</span>}>Open Channel</MenuItem>
            <MenuItem>Mark as Read</MenuItem>
            <MenuItem disabled>Archive unavailable</MenuItem>
            <MenuItem className="border-t border-line-hairline">Delete Message</MenuItem>
          </div>
        </div>
      </main>
    );
  }

  if (caseConfig.kind === "ui-select") {
    return (
      <main className="min-h-screen bg-layer-canvas p-0 font-display text-foreground">
        <div
          data-visual-case={caseConfig.id}
          style={{
            width: 342,
            height: 194,
            boxSizing: "border-box",
            overflow: "hidden",
            background: "var(--layer-canvas)",
            padding: "16px",
          }}
        >
          <div className="flex flex-col gap-4">
            <Select
              value="codex"
              onValueChange={noop}
              items={VISUAL_SELECT_OPTIONS}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select..." />
                <SelectIcon />
              </SelectTrigger>
              <SelectContent>
                <SelectList>
                  {renderVisualSelectItems(VISUAL_SELECT_OPTIONS)}
                </SelectList>
              </SelectContent>
            </Select>
            <Select
              value=""
              disabled
              onValueChange={noop}
              items={VISUAL_DISABLED_SELECT_OPTIONS}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select..." />
                <SelectIcon />
              </SelectTrigger>
              <SelectContent>
                <SelectList>
                  {renderVisualSelectItems(VISUAL_DISABLED_SELECT_OPTIONS)}
                </SelectList>
              </SelectContent>
            </Select>
          </div>
        </div>
      </main>
    );
  }

  if (caseConfig.kind === "ui-badge") {
    return (
      <main className="min-h-screen bg-layer-canvas p-0 font-display text-foreground">
        <div
          data-visual-case={caseConfig.id}
          style={{
            width: 342,
            height: 92,
            boxSizing: "border-box",
            overflow: "hidden",
            background: "var(--layer-canvas)",
            padding: "16px",
          }}
        >
          <div className="flex flex-wrap items-center gap-2">
            <Badge appearance="outline">Shared</Badge>
            <Badge variant="success">Installed</Badge>
            <Badge variant="warning">Update</Badge>
            <Badge variant="muted">Built In</Badge>
            <Badge variant="danger">task #273</Badge>
            <Badge render={<button type="button" />} variant="accent">Install</Badge>
          </div>
        </div>
      </main>
    );
  }

  if (caseConfig.kind === "ui-surface-list-item") {
    return (
      <main className="min-h-screen bg-layer-canvas p-0 font-display text-foreground">
        <div
          data-visual-case={caseConfig.id}
          style={{
            width: 342,
            height: 182,
            boxSizing: "border-box",
            overflow: "hidden",
            background: "var(--layer-canvas)",
            padding: "16px",
          }}
        >
          <div className="flex flex-col gap-3">
            <SurfaceListItem interactive={false}>
              <div className="text-callout font-bold text-foreground">Private app</div>
              <div className="mt-1 font-mono text-mono-meta text-foreground-muted">Available to this server</div>
            </SurfaceListItem>
            <SurfaceListItem selected interactive={false}>
              <div className="text-callout font-bold text-foreground">Active integration</div>
              <div className="mt-1 font-mono text-mono-meta text-foreground-muted">Selected list item state</div>
            </SurfaceListItem>
          </div>
        </div>
      </main>
    );
  }

  if (caseConfig.kind === "ui-avatar-list-row") {
    return (
      <main className="min-h-screen bg-layer-canvas p-0 font-display text-foreground">
        <div
          data-visual-case={caseConfig.id}
          style={{
            width: 342,
            height: 168,
            boxSizing: "border-box",
            overflow: "hidden",
            background: "var(--layer-canvas)",
            padding: "16px",
          }}
        >
          {/* Product use: AvatarListRow is a raft-ui ListRow inside a ListRowGroup. */}
          <ListRowGroup>
            <AvatarListRow
              avatar={<AvatarSlot context="list-row" type="human" humanPlaceholder />}
              name="Cindy"
              subtitle="Claude Code"
              rightContent={<Badge variant="success">Online</Badge>}
            />
            <AvatarListRow
              avatar={<AvatarSlot context="list-row" type="human" humanPlaceholder />}
              name="Product UX Designer"
              subtitle="product@slock.ai"
              rightContent={<Button size="md" variant="outline">Open</Button>}
              selected
            />
          </ListRowGroup>
        </div>
      </main>
    );
  }

  if (caseConfig.kind === "notification-center") {
    return <NotificationCenterVisualCaseView caseConfig={caseConfig} />;
  }

  if (caseConfig.kind === "thread-message") {
    return (
      <main className="min-h-screen bg-layer-canvas p-4 font-display text-foreground">
        {/* 374 = the 390 viewport minus the 16px inset: the Android crop is
            (16,16,374w). At 390 the row ran past the viewport and the capture
            clamp cut its right edge (the timestamp read "10:3"). */}
        <div data-visual-case={caseConfig.id} style={{ width: 374, overflow: "hidden" }}>
          <VisualMessageRow fixture={THREAD_MESSAGE_FIXTURE} />
        </div>
      </main>
    );
  }

  if (caseConfig.kind === "thread-message-deleted-human") {
    return (
      <main className="min-h-screen bg-layer-canvas p-4 font-display text-foreground">
        {/* 374 = the 390 viewport minus the 16px inset: the Android crop is
            (16,16,374w). At 390 the row ran past the viewport and the capture
            clamp cut its right edge (the timestamp read "10:3"). */}
        <div data-visual-case={caseConfig.id} style={{ width: 374, overflow: "hidden" }}>
          <VisualMessageRow fixture={THREAD_MESSAGE_DELETED_HUMAN_FIXTURE} />
        </div>
      </main>
    );
  }

  if (caseConfig.kind === "thread-message-menu") {
    const fixture = caseConfig.id.endsWith(".task") ? THREAD_MESSAGE_MENU_TASK_FIXTURE : THREAD_MESSAGE_MENU_FIXTURE;
    return (
      <main className="min-h-screen bg-layer-canvas p-4 font-display text-foreground">
        <div data-visual-case={caseConfig.id} style={{ width: 390, height: 420, overflow: "hidden" }}>
          <VisualMessageRow fixture={fixture} />
        </div>
      </main>
    );
  }

  if (caseConfig.kind === "thread-message-share-selection") {
    return <ThreadMessageShareSelectionVisualCaseView caseConfig={caseConfig} />;
  }

  if (caseConfig.kind === "thread-message-share-preview") {
    return <SelectSharePreviewPrototype mobile={caseConfig.id.endsWith(".mobile")} />;
  }

  if (caseConfig.kind === "thread-message-rich") {
    return (
      <main className="min-h-screen bg-layer-canvas p-4 font-display text-foreground">
        <div data-visual-case={caseConfig.id} style={{ width: 342, overflow: "hidden" }}>
          <VisualMessageRow fixture={THREAD_MESSAGE_RICH_FIXTURE} />
        </div>
      </main>
    );
  }

  if (caseConfig.kind === "thread-message-long-inline-code") {
    return (
      <main className="min-h-screen bg-layer-canvas p-0 font-display text-foreground">
        {/* 390px matches the Android capture, which crops the full 390dp screen
            width — at 342 the Android row's right edge was cut and every wrap
            point shifted (task #400 width alignment). p-0 (not the usual p-4)
            so the full 390px fits the 390-wide viewport without clipping. */}
        <div data-visual-case={caseConfig.id} style={{ width: 390, overflow: "hidden" }}>
          <VisualMessageRow fixture={THREAD_MESSAGE_LONG_INLINE_CODE_FIXTURE} />
        </div>
      </main>
    );
  }

  if (caseConfig.kind === "thread-message-md-link-ref") {
    return (
      <main className="min-h-screen bg-layer-canvas p-0 font-display text-foreground">
        {/* 390px matches the Android capture crop (full 390dp screen width),
            same width contract as the long-inline-code case (task #400). */}
        <div data-visual-case={caseConfig.id} style={{ width: 390, overflow: "hidden" }}>
          <VisualMessageRow fixture={THREAD_MESSAGE_MD_LINK_REF_FIXTURE} />
        </div>
      </main>
    );
  }

  if (caseConfig.kind === "thread-message-md-latest-release") {
    return (
      <main className="min-h-screen bg-layer-canvas p-0 font-display text-foreground">
        <div data-visual-case={caseConfig.id} style={{ width: 390, overflow: "hidden" }}>
          <VisualMessageRow fixture={THREAD_MESSAGE_MD_LATEST_RELEASE_FIXTURE} />
        </div>
      </main>
    );
  }

  if (caseConfig.kind === "thread-message-md-wrap-slice1") {
    return (
      <main className="min-h-screen bg-layer-canvas p-0 font-display text-foreground">
        {/* 260px narrow column (viewport width 260) forces a channel/task chip
            to wrap to the next line — the whole point of this case. overflow
            hidden so the column matches the Android 260dp fixture crop. */}
        <div data-visual-case={caseConfig.id} style={{ width: 260, overflow: "hidden" }}>
          <VisualMessageRow fixture={THREAD_MESSAGE_MD_WRAP_SLICE1_FIXTURE} />
        </div>
      </main>
    );
  }

  if (caseConfig.kind === "thread-message-md-wrap-clarify") {
    return (
      <main className="min-h-screen bg-layer-canvas p-0 font-display text-foreground">
        <div data-visual-case={caseConfig.id} style={{ width: 260, overflow: "hidden" }}>
          <VisualMessageRow fixture={THREAD_MESSAGE_MD_WRAP_CLARIFY_FIXTURE} />
        </div>
      </main>
    );
  }

  if (caseConfig.kind === "thread-message-md-wrap-adjacent") {
    return (
      <main className="min-h-screen bg-layer-canvas p-0 font-display text-foreground">
        <div data-visual-case={caseConfig.id} style={{ width: 390, overflow: "hidden" }}>
          <VisualMessageRow fixture={THREAD_MESSAGE_MD_WRAP_ADJACENT_FIXTURE} />
        </div>
      </main>
    );
  }

  if (caseConfig.kind === "thread-message-md-wrap-status606") {
    return (
      <main className="min-h-screen bg-layer-canvas p-0 font-display text-foreground">
        <div data-visual-case={caseConfig.id} style={{ width: 390, overflow: "hidden" }}>
          <VisualMessageRow fixture={THREAD_MESSAGE_MD_WRAP_STATUS606_FIXTURE} />
        </div>
      </main>
    );
  }

  if (caseConfig.kind === "thread-message-md-wrap-task607") {
    return (
      <main className="min-h-screen bg-layer-canvas p-0 font-display text-foreground">
        <div data-visual-case={caseConfig.id} style={{ width: 260, overflow: "hidden" }}>
          <VisualMessageRow fixture={THREAD_MESSAGE_MD_WRAP_TASK607_FIXTURE} />
        </div>
      </main>
    );
  }

  if (caseConfig.kind === "thread-message-agent-read-line") {
    return <AgentReadLineCase caseId={caseConfig.id} />;
  }

  if (caseConfig.kind === "thread-forward-modal") {
    return <ThreadForwardModalVisualCaseView caseConfig={caseConfig} />;
  }


  if (caseConfig.kind === "thread-comment-anchor") {
    // React reference for the Android attachment-comments dialog
    // (ThreadAttachmentCommentsDialog / captureThreadCommentAnchor, task
    // #566): one anchored comment + a pending anchor above the composer, so
    // the diff pins the anchor chip inset against the comment field below it
    // (the #566 regression). Comment data comes from the spec's
    // /attachments/att-anchor-1/comments stub.
    return (
      <main className="min-h-screen bg-layer-canvas p-0 font-display text-foreground">
        <div data-visual-case={caseConfig.id} style={{ width: 390, height: 844, overflow: "hidden" }}>
          <AttachmentCommentsPanel
            attachmentId="att-anchor-1"
            filename="agent-tabs-full-page-review.mp4"
            parentMessage={COMMENT_ANCHOR_PARENT_MESSAGE}
            pendingAnchor={COMMENT_ANCHOR_PENDING_ANCHOR}
          />
        </div>
      </main>
    );
  }

  if (caseConfig.kind === "channel-settings") {
    return <ChannelDrawerVisualCaseView caseConfig={caseConfig} />;
  }

  if (caseConfig.kind === "channel-members") {
    // Phone-width members page as the channel overflow drawer hosts it
    // (bare full-screen sheet body, presentation="page"); the capture taps
    // the bottom-pinned Add Member entry to open the add-member view.
    return (
      <main className="min-h-screen bg-layer-canvas p-0 font-display text-foreground">
        <div
          data-visual-case={caseConfig.id}
          className="flex flex-col"
          style={{ width: 390, height: 844, overflow: "hidden" }}
        >
          <ChannelMembers channelId="channel-design" presentation="page" />
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-layer-canvas p-0 font-display text-foreground">
      <div data-visual-case={caseConfig.id} style={{ width: 390, height: 844, overflow: "hidden" }}>
        <MessageSearchPage />
      </div>
    </main>
  );
}

const SHARE_SELECTION_MESSAGES: Message[] = [
  {
    id: "msg-share-selection-1",
    channelId: fxChannels.design.id,
    senderType: "agent",
    senderId: fxCindy.id,
    senderName: fxCindy.displayName,
    content: fxMessages.threadDefault,
    threadId: "thread-msg-share-selection-1",
    createdAt: fxTimes.threadMessageAtIso,
    reactions: [{ emoji: "👍", count: 2, reactorIds: [fxOwner.id], reactorNames: [fxOwner.name] }],
  },
  {
    id: "msg-share-selection-2",
    channelId: fxChannels.design.id,
    senderType: "user",
    senderId: fxOwner.id,
    senderName: fxOwner.displayName,
    content: fxMessages.composerSeed,
    threadId: "thread-msg-share-selection-2",
    createdAt: fxTimes.threadReplyAtIso,
  },
];

function ThreadMessageShareSelectionVisualCaseView({ caseConfig }: { caseConfig: DirectVisualCase }) {

  useMemo(() => {
    useSelectionStore.setState({
      channelId: fxChannels.design.id,
      threadRootId: null,
      threadRootChannelId: null,
      isActive: true,
      selectedIds: new Set(SHARE_SELECTION_MESSAGES.map((message) => message.id)),
    });
  }, []);

  const channels = useChannelStore.getState().channels;

  return (
    <main className="min-h-screen bg-layer-canvas p-0 font-display text-foreground">
      <div
        data-visual-case={caseConfig.id}
        style={{
          width: 390,
          height: 844,
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          background: "var(--layer-canvas)",
        }}
      >
        <div style={{ flex: "1 1 auto", overflow: "hidden", padding: "16px 16px 0" }}>
          {SHARE_SELECTION_MESSAGES.map((message) => (
            <MessageItem
              key={message.id}
              message={message}
              mentionMap={VISUAL_MENTION_MAP}
              channels={channels}
              previewSenderAgent={message.senderType === "agent" ? visualAgents[0] : undefined}
              hideThreadActions
            />
          ))}
        </div>
        <SelectModeToolbar
          channelId={fxChannels.design.id}
          onSavePic={noop}
          onCopyMd={noop}
          onForward={noop}
          onCopyLinks={noop}
        />
      </div>
    </main>
  );
}

function NavigationTabbarVisualCaseView({ caseConfig }: { caseConfig: DirectVisualCase }) {
  useMemo(() => primeNavigationVisualStores(), []);
  const ready = useVisualRoute(`/s/${fxServer.slug}`, caseConfig.id);
  if (!ready) return null;

  // Element crop wraps exactly the tabbar at its natural height — the old
  // 390x844 shell anchored React's bar at the bottom while Android captured
  // a top-anchored strip, so diffs compared empty space (task #351).
  return (
    <main className="min-h-screen bg-layer-canvas p-0 font-display text-foreground">
      <div data-visual-case={caseConfig.id} style={{ width: 390, background: "var(--layer-canvas)" }}>
        <MobileTabBar />
      </div>
    </main>
  );
}

// The two entries the Android fixture renders (warning agent disconnect,
// info release-gate review), each with its primary action and Dismiss.
const VISUAL_NOTIFICATION_CENTER_ENTRIES: NotificationEntry[] = [
  {
    id: "visual-agent-offline",
    kind: "warning",
    title: "Android-Developer lost connection",
    body: "Last heartbeat was 4 minutes ago.",
    action: { label: "View", onClick: noop },
    dismissalKey: "visual-agent-offline",
  },
  {
    id: "visual-release-blocker",
    kind: "info",
    title: "Release gate needs review",
    body: "Two visual cases changed in the latest run.",
    action: { label: "Open", onClick: noop },
    dismissalKey: "visual-release-blocker",
  },
];

// The real phone Bell (NotificationTrigger) with the fixture entries; the
// manifest's capture interaction clicks it, so the open center is the product
// popover anchored under the Bell, not a hand-placed copy. Until #7347 this
// rendered a removed ui/NotificationCenter and then nothing at all.
function NotificationCenterVisualCaseView({ caseConfig }: { caseConfig: DirectVisualCase }) {
  return (
    <main className="min-h-screen bg-layer-canvas p-0 font-display text-foreground">
      <div
        data-visual-case={caseConfig.id}
        style={{
          width: 390,
          height: 844,
          boxSizing: "border-box",
          overflow: "hidden",
          background: "var(--layer-canvas)",
        }}
      >
        <div className="flex h-14 items-center justify-end px-2">
          <NotificationTrigger flavor="mobile-navbar" notifications={VISUAL_NOTIFICATION_CENTER_ENTRIES} />
        </div>
      </div>
    </main>
  );
}

type HomeTitlebarVisualState = {
  id: string;
  name: string;
  props: {
    serverName: string;
    /** "image": the server has an uploaded avatar; otherwise its initial. */
    serverAvatar?: "image";
    otherServerUnread?: boolean;
    otherServerName?: string;
    switcherOpen?: boolean;
  };
};

const HOME_TITLEBAR_CASE_ID = "components.home.titlebar.states";
const HOME_TITLEBAR_PROP_KEYS = new Set(["serverName", "serverAvatar", "otherServerUnread", "otherServerName", "switcherOpen"]);

// Checks one manifest variant against HomeTitlebarVisualState and throws on
// anything else, so a misspelled or mistyped field fails the capture loudly
// instead of silently rendering a default bar.
function parseHomeTitlebarState(value: unknown): HomeTitlebarVisualState {
  const fail = (reason: string): never => {
    throw new Error(`${HOME_TITLEBAR_CASE_ID} variant ${JSON.stringify(value)}: ${reason}`);
  };
  if (!value || typeof value !== "object") return fail("not an object");
  const { id, name, props } = value as Record<string, unknown>;
  if (typeof id !== "string" || !id) return fail("id must be a non-empty string");
  if (typeof name !== "string" || !name) return fail("name must be a non-empty string");
  if (!props || typeof props !== "object") return fail("props must be an object");
  const record = props as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!HOME_TITLEBAR_PROP_KEYS.has(key)) fail(`unknown prop "${key}"`);
  }
  if (typeof record.serverName !== "string" || !record.serverName) fail("props.serverName must be a non-empty string");
  if (record.serverAvatar !== undefined && record.serverAvatar !== "image") fail('props.serverAvatar must be "image" when set');
  if (record.otherServerName !== undefined && typeof record.otherServerName !== "string") fail("props.otherServerName must be a string");
  for (const key of ["otherServerUnread", "switcherOpen"]) {
    if (record[key] !== undefined && typeof record[key] !== "boolean") fail(`props.${key} must be a boolean`);
  }
  return { id, name, props: record as HomeTitlebarVisualState["props"] };
}

// The states come from the manifest's variants, so React renders exactly the
// board the case declares (Android's KMP page renders the same four). Parsed
// when the titlebar case renders, so a bad variant fails that case only.
let homeTitlebarStatesCache: HomeTitlebarVisualState[] | null = null;
function homeTitlebarStates(): HomeTitlebarVisualState[] {
  homeTitlebarStatesCache ??= parseHomeTitlebarStates();
  return homeTitlebarStatesCache;
}
function parseHomeTitlebarStates(): HomeTitlebarVisualState[] {
  const variants = (sharedCases.cases as Array<{ id: string; variants?: unknown }>)
    .find((visualCase) => visualCase.id === HOME_TITLEBAR_CASE_ID)?.variants;
  if (!Array.isArray(variants) || variants.length === 0) {
    throw new Error(`${HOME_TITLEBAR_CASE_ID}: the manifest declares no variants`);
  }
  return variants.map(parseHomeTitlebarState);
}
// Web server avatars are uploaded images (no pixel keys); a fixed inline image
// stands in for one so no network fetch is involved.
const VISUAL_SERVER_AVATAR_URL = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8" shape-rendering="crispEdges">'
  + '<rect width="8" height="8" fill="#141111"/><rect x="1" y="1" width="2" height="2" fill="#27C6F0"/>'
  + '<rect x="5" y="1" width="2" height="2" fill="#27C6F0"/><rect x="2" y="5" width="4" height="2" fill="#FFFFFF"/></svg>',
)}`;
const TITLEBAR_BAR_HEIGHT = 62;
const TITLEBAR_SWITCHER_FRAME_HEIGHT = 340;
// Each state runs in an iframe as tall as the case's phone viewport, clipped
// to the part the board shows. A frame only as tall as the visible bar (62px,
// or 340px open) is a window under 600px, so the shell's short-window rules
// applied (the 48px `--shell-header-height`, the switcher's compact
// `max-height:600px` rows) and the bar was not the 56px one a phone draws.
const TITLEBAR_FRAME_VIEWPORT_HEIGHT = 844;

function requestedTitlebarState(): HomeTitlebarVisualState | null {
  const id = new URLSearchParams(window.location.search).get("titlebarState");
  return homeTitlebarStates().find((state) => state.id === id) ?? null;
}

function primeHomeTitlebarState(state: HomeTitlebarVisualState) {
  primeNavigationVisualStores();
  const { current, servers } = useServerStore.getState();
  if (!current) return;
  const nextCurrent = {
    ...current,
    name: state.props.serverName,
    avatarUrl: state.props.serverAvatar === "image" ? VISUAL_SERVER_AVATAR_URL : null,
  };
  // Other-server unread needs another server; the other states keep a list
  // without it so no unread dot can ride the avatar.
  const otherServer = servers.find((server) => server.id !== current.id);
  const otherServers = otherServer && (state.props.otherServerUnread || state.props.otherServerName)
    ? [{
        ...otherServer,
        // A separate id from the one the unread-summary mock marks unread,
        // so the switcher row carries no unread count.
        ...(state.props.otherServerName
          ? {
              id: "visual-community-server",
              name: state.props.otherServerName,
              slug: state.props.otherServerName.toLowerCase().replace(/\s+/g, "-"),
            }
          : {}),
      }]
    : [];
  useServerStore.setState({
    current: nextCurrent,
    servers: [nextCurrent, ...otherServers],
    serverUnreadCounts: state.props.otherServerUnread && otherServer
      ? { [otherServer.id]: { unreadCount: 3, serverPushMuted: false, activityUnreadCount: 3 } }
      : {},
  });
}

// One state, rendered by the real phone Sidebar in its own document (an
// iframe of this host): the bar reads the server and unread state from global
// stores, so each state needs its own copy of them.
function HomeTitlebarStateFrame({ state }: { state: HomeTitlebarVisualState }) {
  useMemo(() => primeHomeTitlebarState(state), [state]);
  const routeReady = useVisualRoute(`/s/${fxServer.slug}`, HOME_TITLEBAR_CASE_ID);
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    if (!routeReady) return;
    if (state.props.switcherOpen) {
      document.querySelector<HTMLElement>("[data-testid='mobile-workspace-trigger']")?.click();
    }
    let cancelled = false;
    void document.fonts.ready.then(() => {
      requestAnimationFrame(() => {
        if (cancelled) return;
        setSettled(true);
        window.parent.postMessage({ titlebarStateReady: state.id }, window.location.origin);
      });
    });
    return () => {
      cancelled = true;
    };
  }, [routeReady, state]);
  if (!routeReady) return null;

  return (
    <main className="min-h-screen bg-layer-canvas p-0 font-display text-foreground">
      <div
        data-titlebar-state={state.id}
        data-titlebar-state-ready={settled ? "true" : undefined}
        style={{ width: 342, height: TITLEBAR_BAR_HEIGHT, overflow: "hidden", background: "var(--layer-canvas)" }}
      >
        <Sidebar mobileInline />
      </div>
    </main>
  );
}

function HomeTitlebarVisualCaseView({ caseConfig }: { caseConfig: DirectVisualCase }) {
  const frameState = useMemo(() => requestedTitlebarState(), []);
  // Frames load one after another: four copies of the dev-served app at once
  // exhaust the browser's request budget (ERR_INSUFFICIENT_RESOURCES), while a
  // later frame reuses the modules the first one cached.
  const [readyFrames, setReadyFrames] = useState<string[]>([]);
  useEffect(() => {
    if (frameState) return;
    const onMessage = (event: MessageEvent) => {
      const id = (event.data as { titlebarStateReady?: unknown } | null)?.titlebarStateReady;
      if (event.origin !== window.location.origin || typeof id !== "string") return;
      setReadyFrames((ready) => (ready.includes(id) ? ready : [...ready, id]));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [frameState]);
  if (frameState) return <HomeTitlebarStateFrame state={frameState} />;

  return (
    <main className="min-h-screen bg-layer-canvas p-0 font-display text-foreground">
      <div
        data-visual-case={caseConfig.id}
        style={{
          width: 390,
          height: 844,
          overflow: "hidden",
          background: "var(--layer-canvas)",
        }}
      >
        <div className="flex flex-col gap-1.5" style={{ width: 342, paddingTop: 12 }}>
          {homeTitlebarStates().map((state, index) => (
            <div key={state.id} className="flex flex-col gap-1.5">
              <div className="px-3 font-display text-xs font-medium uppercase text-foreground-muted">{state.name}</div>
              <div
                style={{
                  width: 342,
                  height: state.props.switcherOpen ? TITLEBAR_SWITCHER_FRAME_HEIGHT : TITLEBAR_BAR_HEIGHT,
                  overflow: "hidden",
                }}
              >
                {/* oxlint-disable-next-line react-doctor/iframe-missing-sandbox -- the frame is this same-origin visual host running the app (storage, module loads, postMessage); a sandbox would only break it */}
                <iframe
                  title={state.name}
                  data-titlebar-frame={state.id}
                  src={index <= readyFrames.length
                    ? `/visual-testing.html?${new URLSearchParams({ case: caseConfig.id, titlebarState: state.id }).toString()}`
                    : "about:blank"}
                  style={{
                    display: "block",
                    width: 342,
                    height: TITLEBAR_FRAME_VIEWPORT_HEIGHT,
                    border: 0,
                  }}
                />
              </div>
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}

// components.channel.settings.panel: the channel drawer as people get it —
// ChatPanel's settings trigger opens ChannelOverflowMenu's OverflowSheet (the
// one-line head over Members / Info / Preferences / Actions). The viewport
// decides phone vs desktop. Query params pick the place: `channel` =
// design (public, the default) | private | joint | dm, `view=members` opens
// the members page, `role=member` seeds a member who can't edit (read-only
// description).
const CHANNEL_DRAWER_VISUAL_CHANNELS: Record<string, Channel> = {
  design: {
    id: fxChannels.design.id,
    serverId: fxServer.id,
    name: fxChannels.design.name,
    description: fxChannels.design.description,
    type: "channel",
    createdAt: fxTimes.entityCreatedAtIso,
    joined: true,
  },
  private: {
    id: "channel-roadmap",
    serverId: fxServer.id,
    name: "roadmap",
    description: "Quarter plans and launch dates",
    type: "private",
    createdAt: fxTimes.entityCreatedAtIso,
    joined: true,
  },
  joint: {
    id: "channel-partner-launch",
    serverId: fxServer.id,
    name: "partner-launch",
    description: "Shared with Android Lab for the launch",
    type: "joint",
    createdAt: fxTimes.entityCreatedAtIso,
    joined: true,
  },
  dm: {
    id: "dm-visual-friday",
    serverId: fxServer.id,
    name: "dm-visual-friday",
    description: null,
    type: "dm",
    peerType: "user",
    peerId: "visual-peer-friday",
    peerDisplayName: "Friday",
    createdAt: fxTimes.entityCreatedAtIso,
    joined: true,
  },
};

function primeChannelDrawerVisualStores(params: URLSearchParams): Channel {
  primeNavigationVisualStores();
  const channel = CHANNEL_DRAWER_VISUAL_CHANNELS[params.get("channel") ?? "design"] ?? CHANNEL_DRAWER_VISUAL_CHANNELS.design;
  const others = Object.values(CHANNEL_DRAWER_VISUAL_CHANNELS).filter((item) => item.type !== "dm");
  useChannelStore.setState((state) => ({
    channels: [...state.channels.filter((item) => !others.some((o) => o.id === item.id)), ...others],
    dmChannels: [CHANNEL_DRAWER_VISUAL_CHANNELS.dm],
  }));
  if (params.get("role") === "member") {
    useServerStore.setState((state) => ({
      current: state.current ? { ...state.current, role: "member" } : state.current,
    }));
  }
  return channel;
}

function clickWhenReady(testId: string, then?: () => void) {
  let tries = 0;
  const tick = () => {
    const target = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
    if (target) {
      target.click();
      then?.();
    } else if (tries < 100) {
      tries += 1;
      window.setTimeout(tick, 50);
    }
  };
  tick();
}

function ChannelDrawerVisualCaseView({ caseConfig }: { caseConfig: DirectVisualCase }) {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const channel = useMemo(() => primeChannelDrawerVisualStores(params), [params]);
  useEffect(() => {
    clickWhenReady("channel-overflow-trigger", () => {
      if (params.get("view") === "members") clickWhenReady("channel-overflow-members-entry");
    });
  }, [params]);

  return (
    <main className="min-h-screen bg-layer-canvas p-0 font-display text-foreground">
      <div
        data-visual-case={caseConfig.id}
        className="flex flex-col"
        style={{ width: "100vw", height: "100vh", overflow: "hidden" }}
      >
        <ChatPanel channel={channel} showComposer={false} />
      </div>
    </main>
  );
}

function ThreadHeaderVisualCaseView({ caseConfig }: { caseConfig: DirectVisualCase }) {
  useMemo(() => primeNavigationVisualStores(), []);
  const channel = useMemo(() => (
    useChannelStore.getState().channels.find((item) => item.id === "channel-home") ?? null
  ), []);

  // Header-strip capture: clip ChatPanel to its PanelHeader (62px) + chat
  // tab strip. The previous unconstrained wrapper captured the full-screen
  // panel, so React and Android compared whole screens (task #351).
  return (
    <main className="min-h-screen bg-layer-canvas p-0 font-display text-foreground">
      <div
        data-visual-case={caseConfig.id}
        style={{ width: 390, height: 120, overflow: "hidden", background: "var(--layer-canvas)" }}
      >
        <ChatPanel
          channel={channel}
          readOnly
        />
      </div>
    </main>
  );
}

function SettingsVisualCaseView({ caseConfig }: { caseConfig: SettingsVisualCase }) {
  useMemo(() => primeSettingsVisualStores(caseConfig), [caseConfig]);
  const rootReady = useVisualRoute(settingsRootPath(caseConfig), caseConfig.id);

  if (caseConfig.root) {
    if (!rootReady) return null;

    return (
      <main className="min-h-screen bg-layer-canvas p-0 font-display text-foreground">
        <div data-visual-case={caseConfig.id} style={{ width: 390, height: 844, overflow: "hidden", background: "var(--layer-canvas)" }}>
          <Sidebar mobileInline />
        </div>
      </main>
    );
  }

  // screens.settings.*.full-height (task #388): capture the WHOLE scrollable
  // Settings route at content height (390 wide, height follows content) so it
  // pairs with the Android eager full-height capture. The chrome is UNCLAMPED
  // (no fixed height, no overflow) and drops the `flex-1 overflow-y-auto`
  // SettingsPanel uses so it grows to content height; no min-h-screen so short
  // routes report their true content height (matching the Android
  // contentBottomPx sentinel), not a viewport floor.
  //
  // The global app chrome pins html/body/#root to the visual viewport with
  // `overflow: hidden` (src/index.css) so the app never scrolls the document.
  // That would clamp `document.documentElement.scrollHeight` to the 844px
  // viewport and make Playwright's `fullPage` screenshot clip to one viewport.
  // Unlock those ancestors — ONLY for full-height cases — so the document grows
  // to content height and the whole route is captured.
  if (caseConfig.fullHeight) {
    return (
      <main className="bg-layer-canvas p-0 font-display text-foreground">
        <style>{`html, body { height: auto !important; overflow: visible !important; } #root { position: static !important; height: auto !important; overflow: visible !important; display: block !important; }`}</style>
        <div data-visual-case={caseConfig.id} style={{ width: 390 }}>
          {/* Same content chrome SettingsPanel wraps tab content with, minus
              the flex-1/overflow-y-auto clamp so it grows to content height. */}
          <div className="bg-layer-canvas px-5 py-4">
            <IntegrationsSection />
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-layer-canvas p-0 font-display text-foreground">
      <div data-visual-case={caseConfig.id} style={{ width: 390, height: 844, overflow: "hidden" }}>
        <SettingsPanel
          tab={caseConfig.tab}
          // Manifest variant account-error (state: "error"): surface the
          // avatar-upload failure banner AccountSection shows after a failed
          // upload (task #333). Message mirrors the Android fixture.
          accountInitialError={
            caseConfig.id === "components.settings.account.error-state"
              ? "Avatar upload failed: upload_failed"
              : undefined
          }
        />
      </div>
    </main>
  );
}
