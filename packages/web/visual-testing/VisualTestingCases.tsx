import { useMemo } from "react";

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
} from "raft-ui";
import LoginPage from "../src/components/auth/LoginPage";
import RegisterPage from "../src/components/auth/RegisterPage";
import AccountIdentitySetupPage from "../src/components/auth/AccountIdentitySetupPage";
import AgentDetailPanel from "../src/components/agent/AgentDetailPanel";
import CreateAgentDialog from "../src/components/agent/CreateAgentDialog";
import ChannelMembers from "../src/components/agent/ChannelMembers";
import CreateChannelDialog from "../src/components/channel/CreateChannelDialog";
import InviteHumanDialog from "../src/components/member/InviteHumanDialog";
import EditChannelDialog from "../src/components/channel/EditChannelDialog";
import ForwardComposerDialog from "../src/components/message/ForwardComposerDialog";
import { AttachmentCommentsPanel } from "../src/components/message/AttachmentCommentsPanel";
import Sidebar from "../src/components/layout/Sidebar";
import MainLayout, { MobileTabBar } from "../src/components/layout/MainLayout";
import ChatPanel from "../src/components/message/ChatPanel";
import ChannelFilesPanel from "../src/components/message/ChannelFilesPanel";
import MessageItem, { buildMentionMap } from "../src/components/message/MessageItem";
import MessageInput from "../src/components/message/MessageInput";
import NotificationActivationBanner from "../src/components/message/NotificationActivationBanner";
import SelectModeToolbar from "../src/components/message/SelectModeToolbar";
import MessageSearchPage from "../src/components/search/MessageSearchPage";
import NotificationCenter from "../src/components/ui/NotificationCenter";
import type {
  NotificationCenterEntry,
} from "../src/components/ui/NotificationCenter";
import AttentionDot from "../src/components/ui/AttentionDot";
import AvatarListRow from "../src/components/ui/AvatarListRow";
import AvatarSlot from "../src/components/ui/AvatarSlot";
import Button from "../src/components/ui/Button";
import CheckMarker from "../src/components/ui/CheckMarker";
import Checkbox from "../src/components/ui/Checkbox";
import FormField from "../src/components/ui/FormField";
import MenuItem from "../src/components/ui/MenuItem";
import ProgressBar from "../src/components/ui/ProgressBar";
import SectionHeader from "../src/components/ui/SectionHeader";
import SectionEyebrow from "../src/components/ui/SectionEyebrow";
import SelectionPopover from "../src/components/ui/SelectionPopover";
import Skeleton, { SkeletonRow } from "../src/components/ui/Skeleton";
import SlugInput from "../src/components/ui/SlugInput";
import Spinner from "../src/components/ui/Spinner";
import StatusDot from "../src/components/ui/StatusDot";
import SurfaceListItem from "../src/components/ui/SurfaceListItem";
import Textarea from "../src/components/ui/Textarea";
import InlineBadgeEditor from "../src/components/InlineBadgeEditor";
import TasksPanel from "../src/components/task/TasksPanel";
import FeedbackSdkTrial from "./FeedbackSdkTrial";
import { STATUS_STYLES } from "../src/components/task/taskStatusUi";
import SettingsPanel, { IntegrationsSection } from "../src/components/settings/SettingsPanel";
import PaletteAuditPage from "../src/pages/PaletteAuditPage";
import SavedPanel from "../src/components/saved/SavedPanel";
import ThreadsInbox from "../src/components/thread/ThreadsInbox";
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
import { PROVIDER_CONNECTIONS_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";
import { setServerFeatureFlagForTests } from "../src/store/serverFeatureFlags";
import { SERVER_GUEST_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";
import { useServerStore } from "../src/store/serverStore";
import { useSelectionStore } from "../src/store/selectionStore";
import { useTaskStore } from "../src/store/taskStore";
import type { Task } from "../src/store/taskStore";
import fixtureData from "../../visual-testing/shared/fixtureData.json";
import savedMessagesFixture from "../../visual-testing/shared/savedMessagesFixture.json";
import activityResultsFixture from "../../visual-testing/shared/activityResultsFixture.json";
import tasksFixture from "../../visual-testing/shared/tasksFixture.json";

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
  mode: "login" | "register" | "profile-setup";
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
  "components.auth.register.inputs": {
    id: "components.auth.register.inputs",
    mode: "register",
  },
  "screens.auth.profile-setup": {
    id: "screens.auth.profile-setup",
    mode: "profile-setup",
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
    height: 320,
    composerOffsetTop: 210,
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

const VISUAL_NOTIFICATION_CENTER_ENTRIES: NotificationCenterEntry[] = [
  {
    id: "visual-agent-offline",
    kind: "warning",
    title: "Android-Developer lost connection",
    body: "Last heartbeat was 4 minutes ago.",
    actions: [
      { id: "view", label: "View", variant: "primary" },
      { id: "dismiss", label: "Dismiss", variant: "secondary" },
    ],
  },
  {
    id: "visual-release-blocker",
    kind: "info",
    title: "Release gate needs review",
    body: "Two visual cases changed in the latest run.",
    actions: [
      { id: "open", label: "Open", variant: "primary" },
      { id: "dismiss", label: "Dismiss", variant: "secondary" },
    ],
  },
];

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
  /** Onboarding mode locks name + description to read-only (locked-state baseline). */
  onboarding?: boolean;
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
    | "ui-attention-dot"
    | "ui-avatar-list-row"
    | "ui-badge"
    | "ui-button"
    | "ui-card"
    | "ui-check-marker"
    | "ui-checkbox"
    | "ui-form-field"
    | "ui-progress-bar"
    | "ui-section-header"
    | "ui-section-eyebrow"
    | "ui-select"
    | "ui-selection-popover"
    | "ui-menu-item"
    | "ui-segmented-control"
    | "ui-skeleton"
    | "ui-slug-input"
    | "ui-spinner"
    | "ui-status-dot"
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
    | "thread-message-rich"
    | "thread-message-long-inline-code"
    | "thread-message-md-link-ref"
    | "thread-message-md-latest-release"
    | "thread-message-md-wrap-slice1"
    | "thread-message-md-wrap-clarify"
    | "thread-message-md-wrap-adjacent"
    | "thread-message-md-wrap-status606"
    | "thread-message-md-wrap-task607"
    | "thread-forward-modal"
    | "thread-comment-anchor"
    | "channel-members"
    | "channel-settings"
    | "search"
    | "saved-results"
    | "activity-results"
    | "tasks-panel"
    | "tasks-status-menu";
};

type SettingsVisualCase = {
  id: string;
  tab?: "account" | "server" | "administration" | "billing" | "language-region" | "appearance" | "notifications" | "integrations";
  root?: boolean;
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
  // Onboarding variant baseline. NOTE: this is NOT a "locked input" baseline —
  // onboarding renders a different layout ("Meet Cindy") that does not show the
  // name/description fields at all, so `lockedFieldClass` on those two controls
  // has no reachable trigger. Captured for what it actually is.
  "components.members.create-agent.dialog-onboarding": {
    id: "components.members.create-agent.dialog-onboarding",
    runtime: "codex",
    machineRuntimes: ["codex", "claude"],
    onboarding: true,
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
                      "daemon v0.65.0" next to the separate "Connected" span
                      (machineRunLabel.ts picks daemonVersion for non-computers)
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

type LoginSigningVisualCase = {
  id: string;
};

// screens.auth.login.signing — the in-flight sign-in state (task #372): the
// user has filled email + password and clicked Sign In, and the auth request
// is still pending. The auth store is primed to loading:true so the submit
// button renders "Signing in…" at disabled:opacity-50; the inputs stay
// enabled with normal white styling because React never disables them during
// login. The manifest's fill interactions type the email/password values.
const LOGIN_SIGNING_CASES: Record<string, LoginSigningVisualCase> = {
  "screens.auth.login.signing": {
    id: "screens.auth.login.signing",
  },
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
  "components.ui.attention-dot.states": {
    id: "components.ui.attention-dot.states",
    kind: "ui-attention-dot",
  },
  "components.ui.status-dot.states": {
    id: "components.ui.status-dot.states",
    kind: "ui-status-dot",
  },
  "components.ui.progress-bar.states": {
    id: "components.ui.progress-bar.states",
    kind: "ui-progress-bar",
  },
  "components.ui.skeleton.states": {
    id: "components.ui.skeleton.states",
    kind: "ui-skeleton",
  },
  "components.ui.spinner.states": {
    id: "components.ui.spinner.states",
    kind: "ui-spinner",
  },
  "components.ui.slug-input.states": {
    id: "components.ui.slug-input.states",
    kind: "ui-slug-input",
  },
  "components.ui.section-eyebrow.states": {
    id: "components.ui.section-eyebrow.states",
    kind: "ui-section-eyebrow",
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
  "components.ui.section-header.states": {
    id: "components.ui.section-header.states",
    kind: "ui-section-header",
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
  "components.tasks.panel.states": {
    id: "components.tasks.panel.states",
    kind: "tasks-panel",
  },
  "components.tasks.status-menu": {
    id: "components.tasks.status-menu",
    kind: "tasks-status-menu",
  },
};

const SETTINGS_CASES: Record<string, SettingsVisualCase> = {
  "components.settings.root.page": { id: "components.settings.root.page", root: true },
  "components.settings.account.page": { id: "components.settings.account.page", tab: "account" },
  "components.settings.account.error-state": { id: "components.settings.account.error-state", tab: "account" },
  "components.settings.server.profile": { id: "components.settings.server.profile", tab: "server" },
  "components.settings.appearance.page": { id: "components.settings.appearance.page", tab: "appearance" },
  "components.settings.notifications.page": { id: "components.settings.notifications.page", tab: "notifications" },
  "components.settings.integrations.page": { id: "components.settings.integrations.page", tab: "integrations" },
  "screens.settings.server-danger-modal": { id: "screens.settings.server-danger-modal", tab: "server" },
};

// Elegant-register cases are addressed as "<base-id>.elegant" so the harness can
// pair them (react-elegant <-> android-elegant) by id. The suffix selects the
// elegant theme (see requestedTheme) and is stripped here so the case dispatches
// to the same base view as its brutal sibling.
const ELEGANT_CASE_SUFFIX = ".elegant";

function requestedRawCaseId(): string {
  const params = new URLSearchParams(window.location.search);
  return params.get("case") || "components.thread.composer.empty";
}

function requestedCaseId(): string {
  const raw = requestedRawCaseId();
  return raw.endsWith(ELEGANT_CASE_SUFFIX)
    ? raw.slice(0, -ELEGANT_CASE_SUFFIX.length)
    : raw;
}

// Root theme for the capture: elegant when the case id carries the .elegant
// suffix (or an explicit ?theme=elegant); brutal otherwise. Driven at the app
// root (main.tsx) so a single ThemeProvider owns data-theme — no nested
// provider whose syncDom effect could race the root's.
export function requestedTheme(): "brutal" | "elegant" {
  const params = new URLSearchParams(window.location.search);
  if (params.get("theme") === "elegant") return "elegant";
  return requestedRawCaseId().endsWith(ELEGANT_CASE_SUFFIX) ? "elegant" : "brutal";
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
      gravatarHash: "",
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
        userId: fxOwner.memberId,
        serverId: fxServer.id,
        email: fxOwner.email,
        gravatarHash: "",
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
      gravatarHash: "",
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
    gravatarHash: "",
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
      gravatarHash: "",
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
        userId: visualUser.id,
        serverId: fxServer.id,
        name: visualUser.name,
        displayName: visualUser.displayName,
        description: null,
        email: visualUser.email,
        role: "owner",
        avatarUrl: null,
        gravatarHash: "",
        joinedAt: fxTimes.memberJoinedAtIso,
      },
      {
        userId: fxOwner.memberId,
        serverId: fxServer.id,
        name: fxOwner.name,
        displayName: fxOwner.displayName,
        description: fxOwner.description,
        email: fxOwner.email,
        role: fxOwner.role as "owner",
        avatarUrl: null,
        gravatarHash: "",
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

// screens.auth.login.signing (task #372): pin the auth store to the moment
// right after the user clicks Sign In — signed out (user:null) with the
// login request still in flight (loading:true). LoginPage reads loading from
// the store, so priming it is enough to render the disabled "Signing in…"
// submit button; no API stubs need delaying because login() is never called.
function primeLoginSigningStores() {
  useAuthStore.setState({
    initialized: true,
    loading: true,
    user: null,
  });
}

function primeCreateChannelStores() {
  const visualUser = {
    id: fxOwner.id,
    email: fxOwner.email,
    gravatarHash: "",
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
        gravatarHash: "",
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
        gravatarHash: "",
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
          gravatarHash: "",
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
          gravatarHash: "",
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
  gravatarHash: "",
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
    creatorId: visualUser.id,
    creator: {
      type: "human" as const,
      id: visualUser.id,
      name: visualUser.name,
      displayName: visualUser.displayName,
      avatarUrl: null,
      gravatarHash: "",
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
      gravatarHash: "",
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
    gravatarHash: "",
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
    gravatarHash: "",
    name: fxDesigner.name,
    displayName: fxDesigner.displayName,
    description: fxDesigner.description,
    avatarUrl: null,
    role: "member" as const,
    joinedAt: fxTimes.memberJoinedAtIso,
  },
];

function primeDirectVisualStores() {
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
    latestDaemonVersion: fixtureData.latestVersions.daemon,
    latestComputerVersion: fixtureData.latestVersions.computer,
    loading: false,
    selectedMachineId: VISUAL_MACHINE_ID,
    showAddMachine: false,
    pendingApiKey: null,
    pendingMachineId: null,
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
    // tasksFixture.json) — TasksPanel's mount-time loadServerTasks() then
    // reconciles to identical data instead of wiping the cards (task #353).
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
  useServerStore.setState({
    current: {
      id: fxServer.id,
      name: "Raft Design",
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
        name: "Raft Design",
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

function visualRoutePathForCase(caseId: string): { path: string; params?: Record<string, string> } | null {
  const agentDetail = AGENT_DETAIL_CASES[caseId];
  if (agentDetail?.route === "members-agent-detail") {
    const agentId = fixtureData.agents[agentDetail.agentKey ?? "productUx"].id;
    return { path: `/s/${fxServer.slug}/agent/${agentId}`, params: { agentTab: agentDetailTab(agentDetail) } };
  }
  if (agentDetail?.route === "members-human-detail") {
    return { path: `/s/${fxServer.slug}/human/${fxOwner.memberId}` };
  }
  if (HOME_LOADING_CASES[caseId]) {
    return { path: `/s/${fxServer.slug}` };
  }
  const direct = DIRECT_CASES[caseId];
  if (direct && (direct.kind === "navigation-tabbar" || direct.kind === "home-titlebar")) {
    return { path: `/s/${fxServer.slug}` };
  }
  const settingsCase = SETTINGS_CASES[caseId];
  if (settingsCase?.root) {
    return { path: `/s/${fxServer.slug}/settings` };
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
    <main className="min-h-screen bg-white p-0 font-display text-black">
      <div data-visual-case={caseConfig.id} style={{ width: 390, height: 844, overflow: "hidden" }}>
        <InviteHumanDialog onClose={() => undefined} />
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

  const loginSigningCase = LOGIN_SIGNING_CASES[caseId];
  if (loginSigningCase) return <LoginSigningVisualCaseView caseConfig={loginSigningCase} />;

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
    <main className="min-h-screen bg-white p-6 font-display text-black">
      <div data-visual-unknown-case={caseId} className="border-2 border-black p-4 text-sm font-bold">
        Unknown visual case id: {caseId}. Register it in VisualTestingCases.tsx before capturing.
      </div>
    </main>
  );
}

function ComposerVisualCaseView({ caseConfig }: { caseConfig: ComposerVisualCase }) {
  useMemo(() => primeVisualStores(caseConfig), [caseConfig]);

  return (
    <main className="min-h-screen bg-white p-0 font-display text-black">
      <div
        data-visual-case={caseConfig.visualCaseAttr}
        data-visual-case-id={caseConfig.id}
        style={{
          width: caseConfig.width || 342,
          height: caseConfig.height || 100,
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
            ? <NotificationActivationBanner placement="mobile" />
            : undefined}
          {...(caseConfig.pendingMentionActionsAfterSend ? {} : { onSendOverride: async () => undefined })}
        />
        {caseConfig.activationPlacement === "desktop" ? (
          <NotificationActivationBanner placement="desktop" />
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
    <main className="min-h-screen bg-white p-0 font-display text-black">
      <div data-visual-case={caseConfig.id} style={{ width: 390, height: 844, overflow: "hidden" }}>
        {caseConfig.mode === "register" ? (
          <RegisterPage onSwitchToLogin={() => undefined} />
        ) : caseConfig.mode === "profile-setup" ? (
          <AccountIdentitySetupPage
            previewUser={{
              ...visualUser,
              name: "pending_new_designer",
              displayName: null,
              profileSetupCompletedAt: null,
              profileSetupSuggestedHandle: "new_designer",
              profileSetupProvider: null,
            }}
            onPreviewComplete={async () => undefined}
          />
        ) : (
          <LoginPage onSwitchToRegister={() => undefined} onForgotPassword={() => undefined} />
        )}
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
    <main className="min-h-screen bg-white p-0 font-display text-black">
      <div data-visual-case={caseConfig.id} style={{ width: 390, height: 844, overflow: "hidden" }}>
        <AgentDetailPanel agent={agent} onClose={() => undefined} />
      </div>
    </main>
  );
}

function MembersHumanDetailRouteVisualCaseView({ caseConfig }: { caseConfig: AgentDetailVisualCase }) {
  const ready = useVisualRoute(`/s/${fxServer.slug}/human/${fxOwner.memberId}`, caseConfig.id);
  if (!ready) return null;

  return (
    <main className="min-h-screen bg-white p-0 font-display text-black">
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
    <main className="min-h-screen bg-white p-0 font-display text-black">
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

function LoginSigningVisualCaseView({ caseConfig }: { caseConfig: LoginSigningVisualCase }) {
  useMemo(() => primeLoginSigningStores(), []);

  // App.tsx renders LoginPage directly (no route) for signed-out users inside
  // the #root flex column, so mount it the same way. The wrapper is a flex
  // column so AuthBrandShell's `flex-1` root stretches to the full 844px
  // viewport and the sign-in card stays vertically centered like the real
  // login screen. The email/password values come from the manifest's fill
  // interactions; loading:true comes from primeLoginSigningStores.
  return (
    <main className="min-h-screen bg-white p-0 font-display text-black">
      <div
        data-visual-case={caseConfig.id}
        style={{ width: 390, height: 844, overflow: "hidden", display: "flex", flexDirection: "column" }}
      >
        <LoginPage onSwitchToRegister={() => undefined} onForgotPassword={() => undefined} />
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
    <main className="min-h-screen bg-white p-0 font-display text-black">
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
    <main className="min-h-screen bg-white p-0 font-display text-black">
      <div data-visual-case={caseConfig.id} data-visual-runtime={caseConfig.runtime}>
        {/* `onboardingShell` is not optional in practice. Production never renders
            `onboarding` without it: the real setup gate (ServerSetupProjectionGate)
            and the setup preview page both pass "step", and the only other caller
            feeds `onboarding` from a store flag nothing sets true. Omitting it here
            produced a modal-wrapped shell with a close X no user can reach — and I
            reported screenshots of that shape as if it were real
            (@cindyz caught it, 2026-08-29). */}
        <CreateAgentDialog
          defaultMachineId={VISUAL_MACHINE_ID}
          prefilledName={caseConfig.empty ? "" : (caseConfig.prefilledName ?? "Product-QA-Bot")}
          prefilledDescription={caseConfig.empty ? "" : "Watches release screenshots and reports visual regressions before merge."}
          onboarding={caseConfig.onboarding}
          onboardingShell={caseConfig.onboarding ? "step" : undefined}
          onClose={() => undefined}
        />
      </div>
    </main>
  );
}

function CreateChannelVisualCaseView({ caseConfig }: { caseConfig: CreateChannelVisualCase }) {
  useMemo(() => primeCreateChannelStores(), []);
  return (
    <main className="min-h-screen bg-white p-0 font-display text-black">
      <div data-visual-case={caseConfig.id} style={{ width: 390, height: 844, overflow: "hidden" }}>
        {/* Values follow the manifest variant prefilled-members: name
            android-artifacts, description "Build reports, screenshots,
            release blockers", selected human+agent (task #334). */}
        <CreateChannelDialog
          prefilledName="android-artifacts"
          prefilledDescription="Build reports, screenshots, release blockers"
          prefilledVisibility="public"
          prefilledAgentIds={["agent-cindy"]}
          prefilledHumanIds={["visual-human-designer"]}
          onClose={() => undefined}
        />
      </div>
    </main>
  );
}

function DirectVisualCaseView({ caseConfig }: { caseConfig: DirectVisualCase }) {
  useMemo(() => primeDirectVisualStores(), []);

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
    const channel: Channel = {
      id: VISUAL_CHANNEL_ID,
      serverId: fxServer.id,
      name: fxChannels.design.name,
      description: fxChannels.design.description,
      type: "channel",
      createdAt: fxTimes.entityCreatedAtIso,
      joined: true,
    };
    return (
      <main className="min-h-screen bg-white p-0 font-display text-black">
        <div data-visual-case={caseConfig.id} style={{ width: 390, height: 360, overflow: "hidden" }}>
          <ChannelFilesPanel channel={channel} />
        </div>
      </main>
    );
  }

  if (caseConfig.kind === "saved-results") {
    return (
      <main className="min-h-screen bg-white p-0 font-display text-black">
        <div data-visual-case={caseConfig.id} style={{ width: 342, height: 620, overflow: "hidden" }}>
          <SavedPanel />
        </div>
      </main>
    );
  }

  if (caseConfig.kind === "activity-results") {
    return (
      <main className="min-h-screen bg-white p-0 font-display text-black">
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
      <main className="min-h-screen bg-white p-0 font-display text-black">
        <div data-visual-case={caseConfig.id} style={{ width: 390, background: "white" }}>
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
      <main className="min-h-screen bg-white p-0 font-display text-black">
        <div
          data-visual-case={caseConfig.id}
          style={{
            width: 342,
            height: 260,
            boxSizing: "border-box",
            background: "white",
            padding: "16px",
          }}
        >
          <InlineBadgeEditor
            displayValue={EN_MESSAGES[STATUS_STYLES.in_progress.labelId]}
            selectedId="in_progress"
            options={TASK_STATUS_MENU_OPTIONS}
            onSelect={() => undefined}
            open
            onToggle={() => undefined}
            badgeClassName={STATUS_STYLES.in_progress.bg}
            uppercase={false}
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
      <main className="min-h-screen bg-white p-0 font-display text-black">
        <div data-visual-case={caseConfig.id} style={{ width: 342, height: 620, overflow: "hidden" }}>
          <PaletteAuditPage />
        </div>
      </main>
    );
  }

  if (caseConfig.kind === "ui-segmented-control") {
    return (
      <main className="min-h-screen bg-white p-0 font-display text-black">
        <div
          data-visual-case={caseConfig.id}
          style={{
            width: 342,
            minHeight: 96,
            boxSizing: "border-box",
            overflow: "hidden",
            background: "white",
            padding: "16px",
          }}
        >
          <SegmentedControl value="mentions" aria-label="Inbox filter visual fixture" onValueChange={() => undefined}>
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
      <main className="min-h-screen bg-white p-0 font-display text-black">
        <div
          data-visual-case={caseConfig.id}
          style={{
            width: 342,
            height: 150,
            boxSizing: "border-box",
            overflow: "hidden",
            background: "white",
            padding: "16px",
          }}
        >
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-3">
              <Button size="sm" tone="white">Save</Button>
              <Button size="sm" tone="yellow">Sync</Button>
              <Button size="sm" tone="pink">Delete</Button>
            </div>
            <div className="flex items-center gap-3">
              <Button size="xs" tone="cyan">Add</Button>
              <Button size="md" tone="lime">Continue</Button>
              <Button size="sm" tone="stone" disabled>Disabled</Button>
            </div>
          </div>
        </div>
      </main>
    );
  }

  if (caseConfig.kind === "ui-card") {
    return (
      <main className="min-h-screen bg-white p-0 font-display text-black">
        <div
          data-visual-case={caseConfig.id}
          style={{
            width: 342,
            height: 190,
            boxSizing: "border-box",
            overflow: "hidden",
            background: "white",
            padding: "16px",
          }}
        >
          <div
            className="card-brutal text-black"
            style={{ width: 310, boxSizing: "border-box", padding: "14px" }}
          >
            <div className="flex flex-col gap-2">
              <div className="font-semibold" style={{ fontSize: 16, lineHeight: "20px" }}>
                Channel settings
              </div>
              <div
                className="text-neutral-500 card-register-muted"
                style={{ fontSize: 12, lineHeight: "16px" }}
              >
                Control who can post and how the channel appears to members.
              </div>
              <Button size="sm" tone="yellow">Save changes</Button>
            </div>
          </div>
        </div>
      </main>
    );
  }

  if (caseConfig.kind === "ui-form-field") {
    return (
      <main className="min-h-screen bg-white p-0 font-display text-black">
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
            background: "white",
            padding: "16px",
          }}
        >
          <div className="flex flex-col gap-3">
            <FormField label="Email" labelStyle="plain" required htmlFor="visual-email">
              <input id="visual-email" className="input-brutal w-full" value="cindy@slock.ai" readOnly />
            </FormField>
            <FormField label="Description" optional hint="Shown in channel discovery.">
              <input className="input-brutal w-full" value="Visual parity fixture" readOnly />
            </FormField>
            <FormField label="Server Name" size="compact" error="Name is required">
              <input className="input-brutal w-full !border-brutal-red ring-2 ring-brutal-red/60" value="" readOnly />
            </FormField>
          </div>
        </div>
      </main>
    );
  }

  if (caseConfig.kind === "ui-textarea") {
    return (
      <main className="min-h-screen bg-white p-0 font-display text-black">
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
            background: "white",
            padding: "16px",
          }}
        >
          <div className="flex flex-col gap-4">
            <Textarea
              value="Capture the Android visual artifact and compare it with React."
              readOnly
              rows={3}
              showCounter
              limit={120}
              hint="Plain helper text"
            />
            <Textarea
              value="This agreement copy is too long for the configured limit."
              readOnly
              rows={2}
              showCounter
              limit={40}
              error="Agreement body must be shorter."
            />
          </div>
        </div>
      </main>
    );
  }

  if (caseConfig.kind === "ui-checkbox") {
    return (
      <main className="min-h-screen bg-white p-0 font-display text-black">
        <div
          data-visual-case={caseConfig.id}
          style={{
            width: 342,
            height: 132,
            boxSizing: "border-box",
            overflow: "hidden",
            background: "white",
            padding: "16px",
          }}
        >
          <div className="flex flex-col gap-3 text-sm font-bold">
            <label className="flex items-center gap-2">
              <Checkbox checked readOnly />
              <span>As Task selected</span>
            </label>
            <label className="flex items-center gap-2">
              <Checkbox checked={false} readOnly size="md" />
              <span>Permission row unchecked</span>
            </label>
            <label className="flex items-center gap-2 opacity-60">
              <Checkbox checked disabled size="md" />
              <span>Disabled checked</span>
            </label>
          </div>
        </div>
      </main>
    );
  }

  if (caseConfig.kind === "ui-check-marker") {
    return (
      <main className="min-h-screen bg-white p-0 font-display text-black">
        <div
          data-visual-case={caseConfig.id}
          style={{
            width: 342,
            height: 112,
            boxSizing: "border-box",
            overflow: "hidden",
            background: "white",
            padding: "16px",
          }}
        >
          <div className="flex flex-col gap-3 text-sm font-bold">
            <div className="flex items-center gap-3">
              <CheckMarker checked size="sm" />
              <span>Square checked</span>
            </div>
            <div className="flex items-center gap-3">
              <CheckMarker checked={false} size="md" />
              <span>Square unchecked</span>
            </div>
            <div className="flex items-center gap-3">
              <CheckMarker checked shape="circle" size="lg" tone="yellow-fill" />
              <span>Circle yellow</span>
            </div>
          </div>
        </div>
      </main>
    );
  }

  if (caseConfig.kind === "ui-attention-dot") {
    return (
      <main className="min-h-screen bg-white p-0 font-display text-black">
        <div
          data-visual-case={caseConfig.id}
          style={{
            width: 342,
            height: 80,
            boxSizing: "border-box",
            overflow: "hidden",
            background: "white",
            padding: "16px",
          }}
        >
          <div className="flex items-center gap-5 text-sm font-bold">
            <span className="flex items-center gap-2"><AttentionDot />Unread</span>
            <span className="flex items-center gap-2"><AttentionDot size="sm" />Compact</span>
            <span className="flex items-center gap-2"><AttentionDot tone="bg-brutal-orange" />Warning</span>
          </div>
        </div>
      </main>
    );
  }

  if (caseConfig.kind === "ui-status-dot") {
    return (
      <main className="min-h-screen bg-white p-0 font-display text-black">
        <div
          data-visual-case={caseConfig.id}
          style={{
            width: 342,
            height: 92,
            boxSizing: "border-box",
            overflow: "hidden",
            background: "white",
            padding: "16px",
          }}
        >
          <div className="flex flex-col gap-3 text-sm font-bold">
            <div className="flex items-center gap-3">
              <StatusDot tone="bg-brutal-lime" />
              <StatusDot tone="bg-brutal-orange" size="sm" />
              <StatusDot tone="bg-gray-400" size="lg" />
              <StatusDot external />
            </div>
            <div className="flex items-center gap-2">
              <StatusDot tone="bg-brutal-pink" pulse />
              <span>Waiting pulse</span>
            </div>
          </div>
        </div>
      </main>
    );
  }

  if (caseConfig.kind === "ui-progress-bar") {
    return (
      <main className="min-h-screen bg-white p-0 font-display text-black">
        <div
          data-visual-case={caseConfig.id}
          style={{
            width: 342,
            height: 124,
            boxSizing: "border-box",
            overflow: "hidden",
            background: "white",
            padding: "16px",
          }}
        >
          <div className="flex flex-col gap-4">
            <ProgressBar value={64} label="Downloading update" showPercent tone="pink" />
            <ProgressBar value={28} label="Verifying package" showPercent tone="cyan" />
          </div>
        </div>
      </main>
    );
  }

  if (caseConfig.kind === "ui-skeleton") {
    return (
      <main className="min-h-screen bg-white p-0 font-display text-black">
        <div
          data-visual-case={caseConfig.id}
          style={{
            width: 342,
            height: 150,
            boxSizing: "border-box",
            overflow: "hidden",
            background: "white",
            padding: "16px",
          }}
        >
          <div className="flex flex-col gap-3">
            <SkeletonRow avatar avatarClassName="size-5" className="gap-3" lineWidths={["w-32", "w-20"]} />
            <Skeleton variant="block" className="h-12 w-full" />
            <div className="flex items-center gap-3">
              <Skeleton variant="circle" className="size-8" />
              <Skeleton variant="line" className="w-40" />
            </div>
          </div>
        </div>
      </main>
    );
  }

  if (caseConfig.kind === "ui-spinner") {
    return (
      <main className="min-h-screen bg-white p-0 font-display text-black">
        <div
          data-visual-case={caseConfig.id}
          style={{
            width: 342,
            height: 92,
            boxSizing: "border-box",
            overflow: "hidden",
            background: "white",
            padding: "16px",
          }}
        >
          <div className="flex items-center gap-5">
            <Spinner size="xs" style={{ animation: "none" }} />
            <Spinner size="sm" style={{ animation: "none" }} />
            <Spinner size="md" style={{ animation: "none" }} />
            <Spinner size="lg" style={{ animation: "none" }} />
            <span className="bg-black p-2">
              <Spinner variant="inverse" size="sm" style={{ animation: "none" }} />
            </span>
          </div>
        </div>
      </main>
    );
  }

  if (caseConfig.kind === "ui-slug-input") {
    return (
      <main className="min-h-screen bg-white p-0 font-display text-black">
        <div
          data-visual-case={caseConfig.id}
          style={{
            width: 342,
            height: 122,
            boxSizing: "border-box",
            overflow: "hidden",
            background: "white",
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

  if (caseConfig.kind === "ui-section-eyebrow") {
    return (
      <main className="min-h-screen bg-white p-0 font-display text-black">
        <div
          data-visual-case={caseConfig.id}
          style={{
            width: 342,
            height: 92,
            boxSizing: "border-box",
            overflow: "hidden",
            background: "white",
            padding: "16px",
          }}
        >
          <div className="flex flex-col gap-3">
            <SectionEyebrow as="div">Recent Activity</SectionEyebrow>
            <SectionEyebrow as="div" className="!text-black">Applications</SectionEyebrow>
            <SectionEyebrow as="label" htmlFor="visual-eyebrow-field" className="bg-white/50 px-2 py-1">
              Choose Avatar
            </SectionEyebrow>
          </div>
        </div>
      </main>
    );
  }

  if (caseConfig.kind === "ui-selection-popover") {
    return (
      <main className="min-h-screen bg-white p-0 font-display text-black">
        <div
          data-visual-case={caseConfig.id}
          style={{
            width: 342,
            height: 252,
            boxSizing: "border-box",
            overflow: "hidden",
            background: "white",
            padding: "16px",
          }}
        >
          <SelectionPopover
            title="Channels"
            showClear
            onClear={() => undefined}
            searchable
            search="des"
            onSearchChange={() => undefined}
            searchPlaceholder="Search channels"
            className="w-full overflow-hidden border-2 border-black bg-white shadow-brutal"
            options={[
              { key: "design", checked: true, label: "design", onClick: () => undefined, reserveLeadingSlot: true },
              { key: "visual-testing", checked: false, label: "visual-testing", onClick: () => undefined, reserveLeadingSlot: true },
              { key: "archive", checked: false, label: "archived channel", disabled: true, onClick: () => undefined, reserveLeadingSlot: true },
              { key: "none", checked: false, label: "No channel", italic: true, onClick: () => undefined, reserveLeadingSlot: true },
            ]}
          />
        </div>
      </main>
    );
  }

  if (caseConfig.kind === "ui-menu-item") {
    return (
      <main className="min-h-screen bg-white p-0 font-display text-black">
        {/* Content-sized: a fixed height clipped the divider/disabled rows out
            of the element crop (task #351). */}
        <div
          data-visual-case={caseConfig.id}
          style={{
            width: 342,
            boxSizing: "border-box",
            background: "white",
            padding: "16px",
          }}
        >
          <div className="w-full overflow-hidden border-2 border-black bg-white shadow-brutal">
            <MenuItem trailing={<span className="font-mono text-xs text-black/40">⌘K</span>}>Open Channel</MenuItem>
            <MenuItem>Mark as Read</MenuItem>
            <MenuItem disabled>Archive unavailable</MenuItem>
            <MenuItem className="border-t border-black/10">Delete Message</MenuItem>
          </div>
        </div>
      </main>
    );
  }

  if (caseConfig.kind === "ui-select") {
    return (
      <main className="min-h-screen bg-white p-0 font-display text-black">
        <div
          data-visual-case={caseConfig.id}
          style={{
            width: 342,
            height: 194,
            boxSizing: "border-box",
            overflow: "hidden",
            background: "white",
            padding: "16px",
          }}
        >
          <div className="flex flex-col gap-4">
            <Select
              value="codex"
              onValueChange={() => undefined}
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
              onValueChange={() => undefined}
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
      <main className="min-h-screen bg-white p-0 font-display text-black">
        <div
          data-visual-case={caseConfig.id}
          style={{
            width: 342,
            height: 92,
            boxSizing: "border-box",
            overflow: "hidden",
            background: "white",
            padding: "16px",
          }}
        >
          <div className="flex flex-wrap items-center gap-2">
            <Badge appearance="outline">Shared</Badge>
            <Badge variant="success">Installed</Badge>
            <Badge variant="warning">Update</Badge>
            <Badge variant="muted">Built In</Badge>
            <Badge variant="danger" uppercase={false}>task #273</Badge>
            <Badge render={<button type="button" />} variant="accent">Install</Badge>
          </div>
        </div>
      </main>
    );
  }

  if (caseConfig.kind === "ui-section-header") {
    return (
      <main className="min-h-screen bg-white p-0 font-display text-black">
        <div
          data-visual-case={caseConfig.id}
          style={{
            width: 342,
            height: 88,
            boxSizing: "border-box",
            overflow: "hidden",
            background: "white",
            padding: "16px",
          }}
        >
          <SectionHeader
            label="Applications"
            count={3}
            action={<Button size="xs" tone="white">Add</Button>}
            className="border-b-2 border-black pb-2"
          />
        </div>
      </main>
    );
  }

  if (caseConfig.kind === "ui-surface-list-item") {
    return (
      <main className="min-h-screen bg-white p-0 font-display text-black">
        <div
          data-visual-case={caseConfig.id}
          style={{
            width: 342,
            height: 182,
            boxSizing: "border-box",
            overflow: "hidden",
            background: "white",
            padding: "16px",
          }}
        >
          <div className="flex flex-col gap-3">
            <SurfaceListItem interactive={false}>
              <div className="text-sm font-bold text-black">Private app</div>
              <div className="mt-1 font-mono text-xs text-black/50">Available to this server</div>
            </SurfaceListItem>
            <SurfaceListItem selected interactive={false}>
              <div className="text-sm font-bold text-black">Active integration</div>
              <div className="mt-1 font-mono text-xs text-black/50">Selected list item state</div>
            </SurfaceListItem>
          </div>
        </div>
      </main>
    );
  }

  if (caseConfig.kind === "ui-avatar-list-row") {
    return (
      <main className="min-h-screen bg-white p-0 font-display text-black">
        <div
          data-visual-case={caseConfig.id}
          style={{
            width: 342,
            height: 168,
            boxSizing: "border-box",
            overflow: "hidden",
            background: "white",
            padding: "16px",
          }}
        >
          <div className="flex flex-col gap-3">
            <AvatarListRow
              avatar={<AvatarSlot context="surface-list" type="human" humanPlaceholder />}
              name="Cindy"
              subtitle="Claude Code"
              rightContent={<Badge variant="success">Online</Badge>}
            />
            <AvatarListRow
              avatar={<AvatarSlot context="surface-list" type="human" humanPlaceholder />}
              name="Product UX Designer"
              subtitle="product@slock.ai"
              rightContent={<Button size="xs" tone="white">Open</Button>}
              selected
            />
          </div>
        </div>
      </main>
    );
  }

  if (caseConfig.kind === "notification-center") {
    return (
      <main className="min-h-screen bg-white p-0 font-display text-black">
        <div
          data-visual-case={caseConfig.id}
          style={{
            width: 390,
            height: 844,
            boxSizing: "border-box",
            overflow: "hidden",
            background: "white",
            padding: "48px 16px 0",
          }}
        >
          <NotificationCenter
            entries={VISUAL_NOTIFICATION_CENTER_ENTRIES}
            viewport="mobile"
            size="regular"
            title="NOTIFICATIONS"
            countLabel="2 items"
            closeOnEscape={false}
            style={{ width: 306 }}
          />
        </div>
      </main>
    );
  }

  if (caseConfig.kind === "thread-message") {
    const message: Message = {
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
    const channels = useChannelStore.getState().channels;
    return (
      <main className="min-h-screen bg-white p-4 font-display text-black">
        <div data-visual-case={caseConfig.id} style={{ width: 390, overflow: "hidden" }}>
          <MessageItem
            message={message}
            mentionMap={buildMentionMap(visualAgents, visualMembers)}
            channels={channels}
            previewSenderAgent={visualAgents[0]}
            // Manifest variant agent-message-task-replies: replyCount 5 +
            // taskNumber 10 → the replies footer chip and task badge must
            // render, so thread actions stay enabled here (task #334).
            threadSummary={{
              threadChannelId: "thread-msg-agent-reply",
              replyCount: 5,
              lastReplyAt: "2026-06-22T03:05:00.000Z",
              participantIds: [fxOwner.id, fxCindy.id],
              unreadCount: 2,
              firstUnreadMessageId: "msg-agent-reply-4",
            }}
            linkedTask={{
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
            } as never}
          />
        </div>
      </main>
    );
  }

  if (caseConfig.kind === "thread-message-deleted-human") {
    const message: Message = {
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
    const channels = useChannelStore.getState().channels;
    return (
      <main className="min-h-screen bg-white p-4 font-display text-black">
        <div data-visual-case={caseConfig.id} style={{ width: 390, overflow: "hidden" }}>
          <MessageItem
            message={message}
            mentionMap={buildMentionMap(visualAgents, visualMembers)}
            channels={channels}
            hideThreadActions
          />
        </div>
      </main>
    );
  }

  if (caseConfig.kind === "thread-message-menu") {
    const isTaskVariant = caseConfig.id.endsWith(".task");
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
    const channels = useChannelStore.getState().channels;
    return (
      <main className="min-h-screen bg-white p-4 font-display text-black">
        <div data-visual-case={caseConfig.id} style={{ width: 390, height: 420, overflow: "hidden" }}>
          <MessageItem
            message={message}
            mentionMap={buildMentionMap(visualAgents, visualMembers)}
            channels={channels}
            previewSenderAgent={visualAgents[0]}
            threadSummary={{
              threadChannelId: message.threadId || "thread-msg-menu-default",
              replyCount: 3,
              participantIds: [fxCindy.id, fxOwner.id],
              unreadCount: 0,
              firstUnreadMessageId: null,
              lastReplyAt: "2026-06-22T02:35:00.000Z",
            }}
            linkedTask={linkedTask}
          />
        </div>
      </main>
    );
  }

  if (caseConfig.kind === "thread-message-share-selection") {
    return <ThreadMessageShareSelectionVisualCaseView caseConfig={caseConfig} />;
  }

  if (caseConfig.kind === "thread-message-rich") {
    const message: Message = {
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
    const linkedTask: Task = {
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
    const channels = useChannelStore.getState().channels;
    return (
      <main className="min-h-screen bg-white p-4 font-display text-black">
        <div data-visual-case={caseConfig.id} style={{ width: 342, overflow: "hidden" }}>
          <MessageItem
            message={message}
            mentionMap={buildMentionMap(visualAgents, visualMembers)}
            channels={channels}
            previewSenderAgent={visualAgents[0]}
            threadSummary={{
              threadChannelId: "thread-msg-rich-visual",
              replyCount: 7,
              participantIds: [fxCindy.id, fxOwner.id],
              unreadCount: 2,
              firstUnreadMessageId: "reply-rich-2",
              lastReplyAt: "2026-06-22T15:32:00.000Z",
            }}
            linkedTask={linkedTask}
          />
        </div>
      </main>
    );
  }

  if (caseConfig.kind === "thread-message-long-inline-code") {
    // React pair for the Android shared `long_inline_code` thread fixture
    // (ThreadPage.kt / captureThreadMessageRowLongInlineCode, task #400): the
    // body mirrors the Android payload byte-for-byte so the diff isolates
    // inline-code chip styling and char-level long-code wrapping (#58/#228)
    // instead of fixture drift.
    const message: Message = {
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
    const linkedTask: Task = {
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
    const markdownChannel: Channel = {
      id: "channel-markdown",
      name: "markdown专修",
      description: "Markdown parity fixtures",
      type: "channel",
      createdAt: "2026-06-18T00:00:00.000Z",
    };
    const channels = [...useChannelStore.getState().channels, markdownChannel];
    return (
      <main className="min-h-screen bg-white p-0 font-display text-black">
        {/* 390px matches the Android capture, which crops the full 390dp screen
            width — at 342 the Android row's right edge was cut and every wrap
            point shifted (task #400 width alignment). p-0 (not the usual p-4)
            so the full 390px fits the 390-wide viewport without clipping. */}
        <div data-visual-case={caseConfig.id} style={{ width: 390, overflow: "hidden" }}>
          <MessageItem
            message={message}
            mentionMap={buildMentionMap(visualAgents, visualMembers)}
            channels={channels}
            previewSenderAgent={visualAgents[0]}
            threadSummary={{
              threadChannelId: "thread-msg-long-inline-code-visual",
              replyCount: 4,
              participantIds: [fxCindy.id, fxOwner.id],
              unreadCount: 1,
              firstUnreadMessageId: "reply_long_inline_code_1",
              lastReplyAt: "2026-06-25T05:57:00.000Z",
            }}
            linkedTask={linkedTask}
          />
        </div>
      </main>
    );
  }

  if (caseConfig.kind === "thread-message-md-link-ref") {
    // React pair for the Android shared `md_link_ref` thread fixture
    // (ThreadPage.kt / captureThreadMessageRowMdLinkRef, task #519): body
    // mirrors the Android payload byte-for-byte. Guards the Raft dialect
    // contract from task #517: refs inside a Markdown link label/destination
    // stay part of that one blue external link; only standalone refs outside
    // links become chips.
    const message: Message = {
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
    const linkedTask: Task = {
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
    const visualTestingChannel: Channel = {
      id: "channel-visual-testing",
      name: "visual-testing",
      description: "Visual parity fixtures",
      type: "channel",
      createdAt: "2026-06-18T00:00:00.000Z",
    };
    const channels = [...useChannelStore.getState().channels, visualTestingChannel];
    return (
      <main className="min-h-screen bg-white p-0 font-display text-black">
        {/* 390px matches the Android capture crop (full 390dp screen width),
            same width contract as the long-inline-code case (task #400). */}
        <div data-visual-case={caseConfig.id} style={{ width: 390, overflow: "hidden" }}>
          <MessageItem
            message={message}
            mentionMap={buildMentionMap(visualAgents, visualMembers)}
            channels={channels}
            previewSenderAgent={visualAgents[0]}
            linkedTask={linkedTask}
          />
        </div>
      </main>
    );
  }

  if (caseConfig.kind === "thread-message-md-latest-release") {
    // Exact mixed-markdown specimen requested by artin (task #502). The body
    // mirrors the shared KMP `md_latest_release` fixture byte-for-byte so the
    // provider diff covers a leading horizontal rule, Chinese prose, bold,
    // inline-code angle-bracket placeholders, and a plain PR reference.
    const message: Message = {
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
    return (
      <main className="min-h-screen bg-white p-0 font-display text-black">
        <div data-visual-case={caseConfig.id} style={{ width: 390, overflow: "hidden" }}>
          <MessageItem
            message={message}
            mentionMap={buildMentionMap(visualAgents, visualMembers)}
            channels={useChannelStore.getState().channels}
            previewSenderAgent={visualAgents[0]}
          />
        </div>
      </main>
    );
  }

  if (caseConfig.kind === "thread-message-md-wrap-slice1") {
    // Narrow (260px) markdown wrap net: the body mirrors the Android shared
    // `md_wrap_slice1` thread fixture byte-for-byte so the diff isolates the
    // inline-box line-wrap bug where a channel/task chip wraps to the next
    // line. Mentions (@artin @Mahua @赵梓淇), channel #raft-mobile-reconcile,
    // and task #787 all chip; PR #791 stays plain (not a known task).
    const message: Message = {
      id: "msg_md_wrap_slice1_visual",
      channelId: "channel-markdown",
      senderType: "agent",
      senderId: fxCindy.id,
      senderName: fxCindy.displayName,
      content:
        "@artin **slice-1 已合入 main** —— PR #791 squash → `80e3162da`。\n\n" +
        "- 重跑那个 flaky job **绿了**（`realtimeReadStatePreservesPartialSummaryAndReconcilesAcceptedRewind` 重跑即过，坐实是 flake 不是我的），Android/OHOS host/OHOS shared 三端 compile+test 全绿、sign-off 过、iOS skip。\n" +
        "- **披露 merge actor**：走 `gh` 身份 `bytemain`（≠ commit author `HanXin`），squash-merge、删了分支。\n" +
        "- 落地形态：flag `sync_core_messages_v0` **默认关 = 零行为变化**；开了才在旁边 shadow fold+persist（不可见、fail-open、eligibility 仍 false）。真实用户完全无感。\n" +
        "- **AD2 的 mapper 解耦设计点**按你说的转 post-merge follow-up，我留着 observer-routed 方案等他定。\n" +
        "- 我另外给 @Mahua 报了那个 flaky 测试（#787 的，main 上间歇误挂无关 PR）。\n\n" +
        "**数据流接线地基这块落了。** 下一步 V2 归一化信封在 #raft-mobile-reconcile 跟 @赵梓淇 对齐字段（他是 canonical DRI）——赵定了形状我就落 mobile V2，然后翻 eligibility 就到你能\"试效果\"那步。",
      mentions: [
        { type: "user", id: fxOwner.id, name: fxOwner.name },
        { type: "user", id: "human-mahua", name: "Mahua" },
        { type: "user", id: "human-zhaoziqi", name: "赵梓淇" },
      ],
      threadId: "thread-msg-md-wrap-slice1-visual",
      createdAt: "2026-07-13T05:55:00.000Z",
    };
    const reconcileChannel: Channel = {
      id: "channel-raft-mobile-reconcile",
      name: "raft-mobile-reconcile",
      description: "Mobile V2 canonical envelope reconcile",
      type: "channel",
      createdAt: "2026-06-18T00:00:00.000Z",
    };
    const channels = [...useChannelStore.getState().channels, reconcileChannel];
    return (
      <main className="min-h-screen bg-white p-0 font-display text-black">
        {/* 260px narrow column (viewport width 260) forces a channel/task chip
            to wrap to the next line — the whole point of this case. overflow
            hidden so the column matches the Android 260dp fixture crop. */}
        <div data-visual-case={caseConfig.id} style={{ width: 260, overflow: "hidden" }}>
          <MessageItem
            message={message}
            mentionMap={buildMentionMap(visualAgents, visualMembers)}
            channels={channels}
            previewSenderAgent={visualAgents[0]}
          />
        </div>
      </main>
    );
  }

  if (caseConfig.kind === "thread-message-md-wrap-clarify") {
    // Narrow (260px) markdown wrap net mirroring the Android shared
    // `md_wrap_clarify` thread fixture byte-for-byte. Mention
    // @Android-Developer-4 and tasks #31 / #521 (bare + `task #521`) all chip.
    const message: Message = {
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
    return (
      <main className="min-h-screen bg-white p-0 font-display text-black">
        <div data-visual-case={caseConfig.id} style={{ width: 260, overflow: "hidden" }}>
          <MessageItem
            message={message}
            mentionMap={buildMentionMap(visualAgents, visualMembers)}
            channels={useChannelStore.getState().channels}
            previewSenderAgent={visualAgents[0]}
          />
        </div>
      </main>
    );
  }

  if (caseConfig.kind === "thread-message-md-wrap-adjacent") {
    // Adjacent-chip acceptance case (task #60): '#31 / #521' as two separate
    // chips on ONE line with a plain slash between (spaced + compact pairs),
    // plus #607 / #对话流专修 tail-glyph controls. Standard 390px width so
    // nothing wraps. Body mirrors the Android md_wrap_adjacent fixture
    // byte-for-byte.
    const message: Message = {
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
    const conversationChannel: Channel = {
      id: "channel-conversation-flow",
      name: "对话流专修",
      description: "Conversation stream fixes",
      type: "channel",
      createdAt: "2026-06-18T00:00:00.000Z",
    };
    const channels = [...useChannelStore.getState().channels, conversationChannel];
    return (
      <main className="min-h-screen bg-white p-0 font-display text-black">
        <div data-visual-case={caseConfig.id} style={{ width: 390, overflow: "hidden" }}>
          <MessageItem
            message={message}
            mentionMap={buildMentionMap(visualAgents, visualMembers)}
            channels={channels}
            previewSenderAgent={visualAgents[0]}
          />
        </div>
      </main>
    );
  }

  if (caseConfig.kind === "thread-message-md-wrap-status606") {
    // Agent-status markdown specimen (artin-requested): thread-ref chip
    // (#对话流专修:661a12bf), short + 64-hex inline codes, task #606 chip,
    // bare PR #785 with NO entity (must stay plain), backtick #/@, @artin.
    // Body mirrors the Android md_wrap_status606 fixture byte-for-byte.
    const message: Message = {
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
    const conversationChannel: Channel = {
      id: "channel-conversation-flow",
      name: "对话流专修",
      description: "Conversation stream fixes",
      type: "channel",
      createdAt: "2026-06-18T00:00:00.000Z",
    };
    const channels = [...useChannelStore.getState().channels, conversationChannel];
    return (
      <main className="min-h-screen bg-white p-0 font-display text-black">
        <div data-visual-case={caseConfig.id} style={{ width: 390, overflow: "hidden" }}>
          <MessageItem
            message={message}
            mentionMap={buildMentionMap(visualAgents, visualMembers)}
            channels={channels}
            previewSenderAgent={visualAgents[0]}
          />
        </div>
      </main>
    );
  }

  if (caseConfig.kind === "thread-message-md-wrap-task607") {
    // Narrow (260px) markdown wrap net mirroring the Android shared
    // `md_wrap_task607` thread fixture byte-for-byte. Mentions
    // (@artin @Android-Developer-2), channel #对话流专修, and task #607 chip.
    const message: Message = {
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
    const conversationChannel: Channel = {
      id: "channel-conversation-flow",
      name: "对话流专修",
      description: "Conversation stream fixes",
      type: "channel",
      createdAt: "2026-06-18T00:00:00.000Z",
    };
    const channels = [...useChannelStore.getState().channels, conversationChannel];
    return (
      <main className="min-h-screen bg-white p-0 font-display text-black">
        <div data-visual-case={caseConfig.id} style={{ width: 260, overflow: "hidden" }}>
          <MessageItem
            message={message}
            mentionMap={buildMentionMap(visualAgents, visualMembers)}
            channels={channels}
            previewSenderAgent={visualAgents[0]}
          />
        </div>
      </main>
    );
  }

  if (caseConfig.kind === "thread-forward-modal") {
    // React reference for the Android Forward target modal
    // (ThreadForwardTargetModal / captureThreadForwardModal, task #560): same
    // seeded destinations so the diff isolates the real react↔android structure.
    const designChannel: Channel = {
      id: "channel-design",
      name: "design",
      description: "Product and UI decisions",
      type: "channel",
      createdAt: "2026-06-18T00:00:00.000Z",
      joined: true,
    };
    const androidChannel: Channel = {
      id: "channel-android",
      name: "android-artifacts",
      description: "Builds and screenshots",
      type: "channel",
      createdAt: "2026-06-18T00:00:00.000Z",
      joined: true,
    };
    const artinDm: Channel = {
      id: "dm-artin",
      name: "artin",
      description: null,
      type: "dm",
      createdAt: "2026-06-18T00:00:00.000Z",
    };
    const cindyDm: Channel = {
      id: "dm-cindy",
      name: "Cindy",
      description: null,
      type: "dm",
      createdAt: "2026-06-18T00:00:00.000Z",
    };
    const sourceMessage: Message = {
      id: "msg-forward-source",
      channelId: designChannel.id,
      senderType: "user",
      senderId: fxOwner.id,
      senderName: fxOwner.name,
      content: "Let's forward this to the right place.",
      threadId: "thread-forward-source",
      createdAt: "2026-06-25T05:55:00.000Z",
    };
    useChannelStore.setState({
      channels: [designChannel, androidChannel],
      dmChannels: [artinDm, cindyDm],
    });
    return (
      <main className="min-h-screen bg-white p-0 font-display text-black">
        <div data-visual-case={caseConfig.id} style={{ width: 390, height: 844, overflow: "hidden" }}>
          <ForwardComposerDialog
            sourceMessages={[
              sourceMessage,
              { ...sourceMessage, id: "msg-forward-source-2", content: "Second forwarded message." },
            ]}
            sourceChannel={designChannel}
            onClose={() => undefined}
            onSent={() => undefined}
          />
        </div>
      </main>
    );
  }


  if (caseConfig.kind === "thread-comment-anchor") {
    // React reference for the Android attachment-comments dialog
    // (ThreadAttachmentCommentsDialog / captureThreadCommentAnchor, task
    // #566): one anchored comment + a pending anchor above the composer, so
    // the diff pins the anchor chip inset against the comment field below it
    // (the #566 regression). Comment data comes from the spec's
    // /attachments/att-anchor-1/comments stub.
    return (
      <main className="min-h-screen bg-white p-0 font-display text-black">
        <div data-visual-case={caseConfig.id} style={{ width: 390, height: 844, overflow: "hidden" }}>
          <AttachmentCommentsPanel
            attachmentId="att-anchor-1"
            filename="agent-tabs-full-page-review.mp4"
            parentMessage={{ id: "msg-anchor-1", channelId: fxChannels.design.id }}
            pendingAnchor={{
              type: "md-section",
              data: {
                headingId: "agent-tabs-full-page-review",
                headingTitle: "agent-tabs-full-page-review.mp4",
              },
            }}
          />
        </div>
      </main>
    );
  }

  if (caseConfig.kind === "channel-settings") {
    return (
      <main className="min-h-screen bg-white p-0 font-display text-black">
        <div data-visual-case={caseConfig.id} style={{ width: 390, height: 844, overflow: "hidden" }}>
          <EditChannelDialog
            channelId="channel-design"
            initialName={fxChannels.design.name}
            initialDescription={fxChannels.design.description}
            onClose={() => undefined}
          />
        </div>
      </main>
    );
  }

  if (caseConfig.kind === "channel-members") {
    return (
      <main className="min-h-screen bg-white p-4 font-display text-black">
        <div data-visual-case={caseConfig.id}>
          <ChannelMembers channelId="channel-design" />
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-white p-0 font-display text-black">
      <div data-visual-case={caseConfig.id} style={{ width: 390, height: 844, overflow: "hidden" }}>
        <MessageSearchPage />
      </div>
    </main>
  );
}

function ThreadMessageShareSelectionVisualCaseView({ caseConfig }: { caseConfig: DirectVisualCase }) {
  const selectedMessages = useMemo<Message[]>(
    () => [
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
    ],
    [],
  );

  useMemo(() => {
    useSelectionStore.setState({
      channelId: fxChannels.design.id,
      threadRootId: null,
      threadRootChannelId: null,
      isActive: true,
      selectedIds: new Set(selectedMessages.map((message) => message.id)),
    });
  }, [selectedMessages]);

  const channels = useChannelStore.getState().channels;

  return (
    <main className="min-h-screen bg-white p-0 font-display text-black">
      <div
        data-visual-case={caseConfig.id}
        style={{
          width: 390,
          height: 844,
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          background: "white",
        }}
      >
        <div style={{ flex: "1 1 auto", overflow: "hidden", padding: "16px 16px 0" }}>
          {selectedMessages.map((message) => (
            <MessageItem
              key={message.id}
              message={message}
              mentionMap={buildMentionMap(visualAgents, visualMembers)}
              channels={channels}
              previewSenderAgent={message.senderType === "agent" ? visualAgents[0] : undefined}
              hideThreadActions
            />
          ))}
        </div>
        <SelectModeToolbar
          channelId={fxChannels.design.id}
          onSavePic={() => undefined}
          onShareX={() => undefined}
          onCopyMd={() => undefined}
          onForward={() => undefined}
          onCopyLinks={() => undefined}
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
    <main className="min-h-screen bg-white p-0 font-display text-black">
      <div data-visual-case={caseConfig.id} style={{ width: 390, background: "white" }}>
        <MobileTabBar />
      </div>
    </main>
  );
}

function HomeTitlebarVisualCaseView({ caseConfig }: { caseConfig: DirectVisualCase }) {
  useMemo(() => primeNavigationVisualStores(), []);
  const ready = useVisualRoute(`/s/${fxServer.slug}`, caseConfig.id);
  if (!ready) return null;

  return (
    <main className="min-h-screen bg-white p-0 font-display text-black">
      <div
        data-visual-case={caseConfig.id}
        style={{
          width: 390,
          height: 844,
          overflow: "hidden",
          background: "white",
        }}
      >
        <div
          style={{
            width: 342,
            height: 110,
            overflow: "hidden",
            background: "white",
            boxSizing: "border-box",
            paddingTop: 48,
          }}
        >
          <div style={{ width: 342, height: 62, overflow: "hidden" }}>
            <Sidebar mobileInline />
          </div>
        </div>
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
    <main className="min-h-screen bg-white p-0 font-display text-black">
      <div
        data-visual-case={caseConfig.id}
        style={{ width: 390, height: 120, overflow: "hidden", background: "white" }}
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
  const rootReady = useVisualRoute(`/s/${fxServer.slug}/settings`, caseConfig.id);

  if (caseConfig.root) {
    if (!rootReady) return null;

    return (
      <main className="min-h-screen bg-white p-0 font-display text-black">
        <div data-visual-case={caseConfig.id} style={{ width: 390, height: 844, overflow: "hidden", background: "white" }}>
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
      <main className="bg-white p-0 font-display text-black">
        <style>{`html, body { height: auto !important; overflow: visible !important; } #root { position: static !important; height: auto !important; overflow: visible !important; display: block !important; }`}</style>
        <div data-visual-case={caseConfig.id} style={{ width: 390 }}>
          {/* Same content chrome SettingsPanel wraps tab content with, minus
              the flex-1/overflow-y-auto clamp so it grows to content height. */}
          <div className="bg-white px-5 py-4">
            <IntegrationsSection />
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-white p-0 font-display text-black">
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
