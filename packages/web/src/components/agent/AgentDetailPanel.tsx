import { useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback } from "react";
import type { ComponentType, FormEvent, ReactNode } from "react";
import { useIntl } from "react-intl";
import type { IntlShape } from "react-intl";
import { createPortal } from "react-dom";
import {
  Activity,
  MessageSquare,
  Play,
  Square,
  Trash2,
  Bug,
  Pencil,
  Check,
  X,
  FolderOpen,
  BellRing,
  BellOff,
  Link2,
  RotateCcw,
  Menu,
  Hash,
  Lock,
  Bot,
  Plus,
  Upload,
  Clipboard,
  HelpCircle,
  MoveRight,
  CircleCheck,
  TriangleAlert,
  Blocks,
} from "lucide-react";
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
  SortableTabsList,
  SortableTabsTab,
  Tabs,
  TabsLabel,
  useOrderedTabs,
} from "raft-ui";
import { useLocation } from "react-router-dom";
import { SIDEBAR_TAB_QUERY_PARAM, useAppNavigate, useMobileBack } from "../../hooks/useAppNavigate";
import {
  getRuntimeDisplayName,
  getDefaultModel,
  getModelLabel,
  getExistingAgentRuntimeOptions,
  isRuntimeDeprecated,
  isExternalAgentRuntime,
  runtimeAvailabilitySuffix,
  runtimeConfigModelValue,
  REASONING_EFFORT_RUNTIMES,
  parseRaftPermalink,
  canChangeMemberRole,
  setClockTimeout,
  TOPBAR_OVERFLOW_FEATURE_FLAG_KEY,
} from "@botiverse/raft-shared";
import type {
  ReasoningEffort,
  RuntimeReasoningEffort,
  ReminderSummary,
  RuntimeConfig,
  RuntimeFormDefinitionRef,
  ServerRole,
} from "@botiverse/raft-shared";
import { formatRuntimeAvailabilitySuffix, formatRuntimeLabelWithStatus } from "../../utils/runtimeAvailabilityLabel";
import { classifyRuntimeError, RUNTIME_ERROR_LABEL_ID } from "../../utils/classifyRuntimeError";
import type { RuntimeErrorKind } from "../../utils/classifyRuntimeError";
import { reasoningEffortLabelId } from "../../utils/reasoningEffortOptions";
import { MachineRunLabel } from "../machine/MachineRunLabel";
import { RuntimeAccountUsageGateChip } from "../machine/RuntimeAccountUsageChip";
import { projectRuntimeModelLabelPresentation, runtimeModelSelectionIsRunnable, useRuntimeModels } from "../../hooks/useRuntimeModels";
import { useExistingAgentRuntimeOptions as useExistingAgentRuntimeSelectionOptions } from "../../hooks/useRuntimeSelectionCatalog";
import { runtimeFormDefinitionRefKey, useRuntimeFormDefinitionCatalog } from "../../hooks/useRuntimeFormDefinition";
import { useTimeFormatter } from "../../hooks/useTimeFormatter";
import { getSocket } from "../../api/socket";
import {
  useAgentStore,
  useAgentDisplayState,
  useAgentCurrentActivityState,
} from "../../store/agentStore";
import type {
  Agent,
  ActivityLogEntry,
  ExternalAgentStatus,
  OnboardingIdentityAdoptionPreview,
} from "../../store/agentStore";
import { useChannelStore } from "../../store/channelStore";
import { useMachineStore } from "../../store/machineStore";
import { resolveAgentMachineRow } from "../../utils/agentMachineRow";
import { resolveAgentServerRoleDisplay } from "../../utils/agentServerRoleDisplay";
import type { Machine } from "../../store/machineStore";
import { useServerStore } from "../../store/serverStore";
import { useServerFeatureFlag } from "../../store/serverFeatureFlags";
import { useAuthStore } from "../../store/authStore";
import { useProfileStore } from "../../store/profileStore";
import { useThreadStore } from "../../store/threadStore";
import { useServerPermissions } from "../../hooks/useServerPermissions";
import { useProviderConnections } from "../../hooks/useProviderConnections";
import { useAgentMigrationStatus } from "../../hooks/useAgentMigrationStatus";
import { useLiveSearchParams } from "../../hooks/useLiveSearchParams";
import type { AgentMigrationNotice as MigrationNotice } from "../../store/agentMigrationRealtime";
import { canViewAgentPrivateSurfaces } from "../../utils/agentVisibility";
import {
  buildRuntimeConfig,
  buildManagedConnectionRuntimeConfig,
  isBuiltInProviderApiKeyInvalid,
  isRuntimeConfigSaveDisabled,
  BUILTIN_RUNTIME_DEFAULT_PROVIDER_ID,
  hydrateRuntimeConfigForm,
  RuntimeConfigBuildError,
  runtimeConfigApiKey,
  runtimeConfigApiUrl,
  runtimeConfigBuiltInProviderApiKey,
  runtimeConfigBuiltInProviderBaseUrl,
  runtimeConfigBuiltInProviderSupportsImageInput,
  runtimeConfigBuiltInProviderMode,
  runtimeConfigCommand,
  runtimeConfigFastMode,
  runtimeConfigPiProviderApiKey,
  runtimeConfigPiProviderMode,
  runtimeConfigProviderMode,
  runtimeConfigProviderConnectionId,
  runtimeIgnoresModel,
  builtInProviderDefaultModel,
  isBuiltInGatewayProviderMode,
  piBuiltinProviderDefaultModel,
  PI_PROVIDER_CONFIGURED,
  supportsRuntimeApiUrl,
  supportsRuntimeBuiltInProvider,
  supportsRuntimeCustomModelName,
  supportsRuntimeFastMode,
  supportsRuntimePiProvider,
} from "../../utils/runtimeConfigForm";
import { buildSchemaDrivenKimiConfig } from "../../utils/schemaRuntimeConfigForm";
import type {
  BuiltInProviderMode,
  PiProviderMode,
  RuntimeProviderMode,
} from "../../utils/runtimeConfigForm";
import { formatRuntimeConfigBuildError } from "../../utils/runtimeConfigBuildErrorPresentation";
import { reconcileReasoningEffort } from "../../utils/reasoningEffortOptions";
import {
  migrationErrorPresentation,
  parseMigrationComputerCapabilityDetails,
  parseMigrationResumableCapabilityDetail,
} from "../../utils/migrationErrorPresentation";
import type {
  MigrationErrorPresentation,
} from "../../utils/migrationErrorPresentation";
import {
  agentMigrationRequiresUpgrade,
  isMigrationProPlanRequiredError,
} from "../../utils/agentMigrationBilling";
import AgentProfileOverflowMenu from "./AgentProfileOverflowMenu";

import { formatActivityText } from "../../utils/activity";
import { getServerUrl } from "../../utils/server";
import { avatarUploadApiErrorMessage, isAvatarFileTooLarge, isAvatarTooLargeError, PROFILE_AVATAR_ACCEPT } from "../../utils/avatarUpload";
import { canViewMachineRuntimeAccountUsage } from "../../utils/machineRuntimeUsageVisibility";
import StatusDot from "../ui/StatusDot";
import ProgressBar from "../ui/ProgressBar";
import { buildAgentDiagnosticInfo } from "../../utils/agentDiagnosticInfo";
import { copyTextToClipboard } from "../../utils/selectMarkdown";
import { ExternalAgentToken } from "./ExternalAgentToken";
import { useCopyText } from "../../hooks/useCopyText";
import CopyButton from "../ui/CopyButton";
import PixelAvatar, { AVATAR_KEYS, parsePixelAvatar, DEFAULT_AVATAR_KEY, isCustomAvatar } from "./PixelAvatar";
import { useImageLightboxStore } from "../../store/imageLightboxStore";
import PanelHeader from "../ui/PanelHeader";
import SectionEyebrow from "../ui/SectionEyebrow";
import SectionHeader from "../ui/SectionHeader";
import ShowMoreToggle from "../ui/ShowMoreToggle";
import KeyValueRow from "../ui/KeyValueRow";
import AvatarSlot from "../ui/AvatarSlot";
import SurfaceListItem from "../ui/SurfaceListItem";
import api from "../../api/client";
import AgentWorkspace from "./AgentWorkspace";
import { AgentMcpTab } from "./AgentMcpTab";
import AgentActivityLog from "./AgentActivityLog";
import AgentSkills from "./AgentSkills";
import AgentRemindersSection from "./AgentRemindersSection";
import ReportIssueDialog from "./ReportIssueDialog";
import AvatarListRow from "../ui/AvatarListRow";
import { AgentDMConversationList } from "./AgentDMConversationList";
import type { AgentDMConversation } from "./AgentDMConversationList";
import InlineBadgeEditor from "../InlineBadgeEditor";
import RolePermissionHelpDialog from "../member/RolePermissionHelpDialog";
import type { MessageId } from "../../i18n/messages/en";

import ResetAgentDialog from "./ResetAgentDialog";
import ConfirmDialog from "../ConfirmDialog";
import Banner from "../ui/Banner";
import EmptyState from "../ui/EmptyState";
import Spinner from "../ui/Spinner";
import Modal from "../Modal";
import RuntimeConfigFields from "./RuntimeConfigFields";
import {
  ExternalSetupTabSegmentedControl,
} from "./ExternalSetupTabSegmentedControl";
import type {
  ExternalSetupTab,
} from "./ExternalSetupTabSegmentedControl";
import { useAgentMigrationUiEnabled } from "./useAgentMigrationUiEnabled";

const MAX_AGENT_DESCRIPTION_LENGTH = 3000;
const FEEDBACK_EXPORT_ENABLED = Boolean(import.meta.env?.VITE_FEEDBACK_EXPORT_URL?.replace(/\/+$/, ""));
const AGENT_TABS = ["profile", "activity", "chat", "reminders", "workspace", "integrations", "mcp"] as const;
type AgentTab = typeof AGENT_TABS[number];
type PanelTabItem<T extends string> = {
  id: T;
  labelId: MessageId;
  icon: ComponentType<{ size?: number; className?: string }>;
};
const AGENT_PANEL_TABS: PanelTabItem<AgentTab>[] = [
  { id: "profile", icon: Bot, labelId: "agent.detail.tab.profile" },
  { id: "activity", icon: Activity, labelId: "agent.detail.tab.activity" },
  { id: "chat", icon: MessageSquare, labelId: "agent.detail.tab.chat" },
  { id: "reminders", icon: BellRing, labelId: "agent.detail.tab.reminders" },
  { id: "workspace", icon: FolderOpen, labelId: "agent.detail.tab.workspace" },
  { id: "integrations", icon: Link2, labelId: "agent.detail.tab.apps" },
  { id: "mcp", icon: Blocks, labelId: "agent.detail.tab.mcp" },
];
const EMPTY_ACTIVITY_LOG: ActivityLogEntry[] = [];
// Default-deny: Profile is the only public tab. Any new tab added to
// AGENT_TABS is private by default until explicitly added to PUBLIC_AGENT_TABS.
// Spec: #proj-server:175df9ee — agent-internal info must not silently widen
// visibility for non-creator members.
const PUBLIC_AGENT_TABS = new Set<AgentTab>(["profile"]);
// Private surfaces — workspace, activity, DMs, reminders, and integrations —
// are visible to creator OR admin. The legacy Permissions tab is intentionally
// no longer exposed from Agent detail; old saved tab orders are ignored because
// they no longer match AGENT_TABS.
const AGENT_ROLE_CONFIG: Record<Extract<ServerRole, "admin" | "member">, { labelId: MessageId; color: string }> = {
  admin: { labelId: "agent.detail.roleAdmin", color: "bg-brutal-pink" },
  member: { labelId: "agent.detail.roleMember", color: "bg-brutal-lavender" },
};
const EDITABLE_AGENT_ROLE_OPTIONS: { id: Extract<ServerRole, "admin" | "member">; labelId: MessageId }[] = [
  { id: "admin", labelId: "agent.detail.roleAdmin" },
  { id: "member", labelId: "agent.detail.roleMember" },
];

interface AgentIntegrationItem {
  id: string;
  type: "pending" | "active";
  serverId: string;
  agentId: string;
  agentName: string;
  agentDisplayName: string | null;
  clientId: string;
  clientKey: string;
  clientName: string;
  clientDescription: string | null;
  clientHomepageUrl: string | null;
  clientAgentManifestUrl: string | null;
  scopes: string[];
  remember: boolean;
  createdAt: string;
  resolvedAt: string | null;
  resolvedByUserId: string | null;
  revokedAt: string | null;
}

interface AgentChannelMembership {
  id: string;
  name: string;
  description: string | null;
  type: "channel" | "private" | "joint";
  createdAt: string;
  archivedAt: string | null;
  activityMuted: boolean;
  muteFromSeq: string | number | null;
}

interface AgentChatDataState<T> {
  items: T[];
  loading: boolean;
  error: string;
}

const EMPTY_AGENT_DMS_STATE: AgentChatDataState<AgentDMConversation> = {
  items: [],
  loading: false,
  error: "",
};

const EMPTY_AGENT_CHANNELS_STATE: AgentChatDataState<AgentChannelMembership> = {
  items: [],
  loading: false,
  error: "",
};
const AGENT_CHAT_CHANNEL_PREVIEW_LIMIT = 5;

function visibleAgentChatChannels(items: AgentChannelMembership[]): AgentChannelMembership[] {
  return items.filter((item) => !item.archivedAt);
}

function AgentChatInlineEmpty({ icon, title, description }: { icon: ReactNode; title: string; description: string }) {
  return (
    <div className="px-4 pb-4">
      <div className="flex items-center gap-3 border border-black/15 bg-black/[0.015] px-3 py-2">
        <div className="shrink-0 text-black/35">{icon}</div>
        <div className="min-w-0">
          <div className="text-sm font-bold text-black/65">{title}</div>
          <div className="mt-0.5 text-xs text-black/45">{description}</div>
        </div>
      </div>
    </div>
  );
}

function AgentChatTab({ agentId }: { agentId: string }) {
  const { formatMessage } = useIntl();
  const formatMessageRef = useRef(formatMessage);
  formatMessageRef.current = formatMessage;
  const nav = useAppNavigate();
  const [dms, setDms] = useState<AgentChatDataState<AgentDMConversation>>(EMPTY_AGENT_DMS_STATE);
  const [channels, setChannels] = useState<AgentChatDataState<AgentChannelMembership>>(EMPTY_AGENT_CHANNELS_STATE);
  const [channelsExpanded, setChannelsExpanded] = useState(false);
  const showCombinedEmptyState = !channels.loading
    && !dms.loading
    && !channels.error
    && !dms.error
    && channels.items.length === 0
    && dms.items.length === 0;

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setDms((state) => ({ ...state, loading: true, error: "" }));
      try {
        const { data } = await api.get(`/agents/${agentId}/agent-dms`);
        if (!cancelled) setDms({ items: data, loading: false, error: "" });
      } catch (err: any) {
        if (!cancelled) {
          setDms({ items: [], loading: false, error: err?.response?.data?.error || formatMessageRef.current({ id: "agent.detail.loadAgentDmsFailed" }) });
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [agentId]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setChannels((state) => ({ ...state, loading: true, error: "" }));
      try {
        const { data } = await api.get(`/agents/${agentId}/channels`);
        if (!cancelled) setChannels({ items: visibleAgentChatChannels(data), loading: false, error: "" });
      } catch (err: any) {
        if (!cancelled) {
          setChannels({ items: [], loading: false, error: err?.response?.data?.error || formatMessageRef.current({ id: "agent.detail.loadAgentChannelsFailed" }) });
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [agentId]);

  const canExpandChannels = channels.items.length > AGENT_CHAT_CHANNEL_PREVIEW_LIMIT;
  const visibleChannels = channelsExpanded
    ? channels.items
    : channels.items.slice(0, AGENT_CHAT_CHANNEL_PREVIEW_LIMIT);

  return (
    <div className="flex-1 overflow-y-auto bg-white">
      <div className="border-b-2 border-black bg-white px-5 py-3">
        <SectionEyebrow as="div">{formatMessage({ id: "agent.detail.channelsAndDms" })}</SectionEyebrow>
      </div>

      {showCombinedEmptyState ? (
        <EmptyState
          className="px-5 py-14"
          icon={(
            <div className="flex items-center gap-3">
              <Hash size={34} />
              <MessageSquare size={34} />
            </div>
          )}
          title={formatMessage({ id: "emptyState.noChatsTitle" })}
          description={formatMessage({ id: "emptyState.noChatsDesc" })}
        />
      ) : (
        <>
          <section className="border-b border-black/10">
            <div className="px-5 py-3">
              <SectionHeader label={formatMessage({ id: "agent.detail.channels" })} />
              <div className="mt-1 text-xs text-black/60">
                {formatMessage({ id: "agent.detail.channelsDescription" })}
              </div>
            </div>
            {channels.loading ? (
              <div className="px-5 pb-4 font-mono text-xs text-black/40">
                {formatMessage({ id: "agent.detail.loadingAgentChannels" })}
              </div>
            ) : channels.error ? (
              <div className="px-5 pb-4">
                <Banner intent="warning" density="sm" className="font-bold">{channels.error}</Banner>
              </div>
            ) : channels.items.length === 0 ? (
              <AgentChatInlineEmpty
                icon={<Hash size={18} />}
                title={formatMessage({ id: "emptyState.noChannelsTitle" })}
                description={formatMessage({ id: "emptyState.noChannelsDesc" })}
              />
            ) : (
              <div className="space-y-3 px-4 pb-4">
                {visibleChannels.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => nav.toChannel(item.id)}
                    className="block w-full text-left"
                  >
                    <SurfaceListItem className="space-y-2">
                      <div className="flex min-w-0 items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex min-w-0 items-center gap-2">
                            {item.type === "private" ? (
                              <Lock size={14} className="shrink-0 text-black/45" aria-label={formatMessage({ id: "agent.detail.privateChannel" })} />
                            ) : (
                              <Hash size={14} className="shrink-0 text-black/45" aria-label={formatMessage({ id: "agent.detail.channel" })} />
                            )}
                            <span className="truncate text-sm font-bold text-black">{item.name}</span>
                            {item.activityMuted && (
                              <span
                                className="inline-flex shrink-0 items-center text-black/45"
                                title={item.muteFromSeq != null
                                  ? formatMessage({ id: "agent.detail.activityMutedFromSeq" }, { seq: item.muteFromSeq })
                                  : formatMessage({ id: "agent.detail.activityMuted" })}
                                aria-label={item.muteFromSeq != null
                                  ? formatMessage({ id: "agent.detail.activityMutedFromSeq" }, { seq: item.muteFromSeq })
                                  : formatMessage({ id: "agent.detail.activityMuted" })}
                              >
                                <BellOff size={13} aria-hidden="true" />
                              </span>
                            )}
                          </div>
                          {item.description && (
                            <div className="mt-1 line-clamp-2 text-xs text-black/60">{item.description}</div>
                          )}
                        </div>
                        {item.type !== "channel" && (
                          <div className="shrink-0 border border-black/20 px-2 py-0.5 text-[11px] font-mono text-black/55">
                            {item.type === "private"
                              ? formatMessage({ id: "agent.detail.private" })
                              : formatMessage({ id: "agent.detail.joint" })}
                          </div>
                        )}
                      </div>
                    </SurfaceListItem>
                  </button>
                ))}
                {canExpandChannels && (
                  <ShowMoreToggle
                    onClick={() => setChannelsExpanded((expanded) => !expanded)}
                    expanded={channelsExpanded}
                    collapsedLabel={formatMessage({ id: "agent.detail.showAllChannels" }, { count: channels.items.length })}
                    expandedLabel={formatMessage({ id: "agent.detail.showFewer" })}
                    aria-expanded={channelsExpanded}
                    data-testid="agent-channels-show-all"
                  />
                )}
              </div>
            )}
          </section>

          <section>
            <div className="px-5 py-3">
              <SectionHeader label={formatMessage({ id: "agent.detail.agentDms" })} />
              <div className="mt-1 text-xs text-black/60">
                {formatMessage({ id: "agent.detail.agentDmsDescription" })}
              </div>
            </div>
            {dms.loading ? (
              <div className="px-5 pb-4 font-mono text-xs text-black/40">
                {formatMessage({ id: "agent.detail.loadingAgentDms" })}
              </div>
            ) : dms.error ? (
              <div className="px-5 pb-4">
                <Banner intent="warning" density="sm" className="font-bold">{dms.error}</Banner>
              </div>
            ) : dms.items.length === 0 ? (
              <AgentChatInlineEmpty
                icon={<MessageSquare size={18} />}
                title={formatMessage({ id: "emptyState.noAgentDmsTitle" })}
                description={formatMessage({ id: "emptyState.noAgentDmsDesc" })}
              />
            ) : (
              <AgentDMConversationList items={dms.items} />
            )}
          </section>
        </>
      )}
    </div>
  );
}

function AgentIntegrationsTab({ agentId, canManageServer }: { agentId: string; canManageServer: boolean }) {
  const { formatMessage } = useIntl();
  const formatMessageRef = useRef(formatMessage);
  formatMessageRef.current = formatMessage;
  const { formatShortDateTime } = useTimeFormatter();
  const [items, setItems] = useState<AgentIntegrationItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const { data } = await api.get(`/integrations/agents/${agentId}`);
      setItems(data);
    } catch (err: any) {
      setError(err.response?.data?.error || formatMessageRef.current({ id: "agent.detail.loadIntegrationsFailed" }));
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  // `loading` is a transient async-fetch indicator (set true at request start,
  // false in the finally block) — not a prop-derived value. react-doctor's
  // no-derived-state flags any setState inside an effect-triggered async path,
  // including legitimate async-loading-state patterns; ignore here.
  useEffect(() => {
    // oxlint-disable-next-line react-doctor/no-derived-state
    load();
  }, [load]);

  const handleRevoke = async (grantId: string) => {
    setError("");
    try {
      await api.post(`/integrations/grants/${grantId}/revoke`);
      await load();
    } catch (err: any) {
      setError(err.response?.data?.error || formatMessage({ id: "agent.detail.revokeIntegrationFailed" }));
    }
  };

  const active = items.filter((item) => item.type === "active");

  return (
    <div className="flex-1 overflow-y-auto bg-white px-5 py-4 space-y-4">
      {error && (
        <Banner intent="warning" density="sm" className="font-bold">{error}</Banner>
      )}

      <div className="space-y-3">
        <div>
          <SectionHeader
            label={formatMessage({ id: "agent.detail.applications" })}
            action={loading ? <span className="text-xs font-bold text-black/50">{formatMessage({ id: "common.loading" })}</span> : null}
          />
          <div className="mt-1 text-xs text-black/60">
            {formatMessage({ id: "agent.detail.applicationsDescription" })}
          </div>
        </div>
        {active.length === 0 ? (
          <div className="text-sm text-black/50">{formatMessage({ id: "agent.detail.noConnectedApps" })}</div>
        ) : (
          <div className="space-y-3">
            {active.map((item) => (
              <SurfaceListItem key={item.id} className="space-y-2" interactive={false}>
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="font-bold text-black">{item.clientName}</div>
                    <div className="text-xs text-black/60">{formatShortDateTime(item.createdAt)}</div>
                  </div>
                  <span className="inline-flex border border-black bg-brutal-lime px-1.5 py-0.5 text-[10px] font-bold uppercase">
                    {formatMessage({ id: "agent.detail.active" })}
                  </span>
                </div>
                {item.clientDescription && <div className="text-sm text-black/70">{item.clientDescription}</div>}
                {item.clientAgentManifestUrl && (
                  <div className="break-all font-mono text-xs text-black/60">
                    {formatMessage({ id: "agent.detail.agentManifest" }, { url: item.clientAgentManifestUrl })}
                  </div>
                )}
                <div className="flex flex-wrap gap-1">
                  {item.scopes.map((scope) => (
                    <span key={scope} className="inline-flex border border-black bg-white px-1.5 py-0.5 text-[10px] font-bold uppercase">
                      {scope}
                    </span>
                  ))}
                </div>
                <div className="flex flex-wrap gap-2">
                  {canManageServer && (
                    <button onClick={() => handleRevoke(item.id)} className="btn-brutal bg-white px-3 py-1.5 text-xs">
                      {formatMessage({ id: "agent.detail.revoke" })}
                    </button>
                  )}
                  {item.clientHomepageUrl && (
                    <a href={item.clientHomepageUrl} target="_blank" rel="noreferrer" className="text-xs font-bold underline text-black/70 self-center">
                      {formatMessage({ id: "agent.detail.viewService" })}
                    </a>
                  )}
                </div>
              </SurfaceListItem>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// Editable environment variables section
function EnvVarsSection({ agent, canManageAgent }: { agent: Agent; canManageAgent: boolean }) {
  const { formatMessage } = useIntl();
  const updateAgent = useAgentStore((s) => s.updateAgent);
  const [editing, setEditing] = useState(false);
  const [entries, setEntries] = useState<{ key: string; value: string }[]>([]);

  const envVars = agent.envVars;
  const hasVars = envVars && Object.keys(envVars).length > 0;

  const startEditing = () => {
    setEntries(
      envVars
        ? Object.entries(envVars).map(([key, value]) => ({ key, value }))
        : []
    );
    setEditing(true);
  };

  const handleSave = async () => {
    const newVars: Record<string, string> = {};
    for (const entry of entries) {
      const k = entry.key.trim();
      if (k) newVars[k] = entry.value;
    }
    await updateAgent(agent.id, {
      envVars: Object.keys(newVars).length > 0 ? newVars : null,
    });
    setEditing(false);
  };

  if (!hasVars && !canManageAgent) return null;

  return (
    <div className="w-full">
      <div className="flex items-center gap-2 mb-1">
        <SectionEyebrow as="div">
          {formatMessage({ id: "agent.runtimeConfig.envVars" })}
        </SectionEyebrow>
        {canManageAgent && !editing && (
          <button
            type="button"
            onClick={startEditing}
            className="text-black/40 hover:text-black transition-colors"
            title={formatMessage({ id: "agent.detail.editEnvironmentVariables" })}
          >
            <Pencil size={12} />
          </button>
        )}
      </div>
      {editing ? (
        <div className="space-y-2">
          {entries.map((entry, i) => (
            <div key={i} className="flex items-center gap-2">
              <input
                type="text"
                value={entry.key}
                onChange={(e) => {
                  const updated = [...entries];
                  updated[i] = { ...updated[i], key: e.target.value };
                  setEntries(updated);
                }}
                className="border-2 border-black px-2 py-1 text-xs font-mono shadow-brutal-sm focus:outline-none w-1/3"
                placeholder={formatMessage({ id: "agent.runtimeConfig.envVarName" })}
              />
              <span className="text-black/40">=</span>
              <input
                type="text"
                value={entry.value}
                onChange={(e) => {
                  const updated = [...entries];
                  updated[i] = { ...updated[i], value: e.target.value };
                  setEntries(updated);
                }}
                className="border-2 border-black px-2 py-1 text-xs font-mono shadow-brutal-sm focus:outline-none flex-1"
                placeholder={formatMessage({ id: "agent.runtimeConfig.envVarFallback" })}
              />
              <button
                type="button"
                onClick={() => setEntries(entries.filter((_, j) => j !== i))}
                className="btn-brutal-sm bg-white p-1"
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setEntries([...entries, { key: "", value: "" }])}
              className="flex items-center gap-1 text-xs font-bold text-black/60 hover:text-black"
            >
              <Plus size={12} />
              {formatMessage({ id: "agent.runtimeConfig.addVariable" })}
            </button>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              onClick={handleSave}
              className="btn-brutal-sm bg-brutal-pink px-2 py-1 text-xs"
            >
              {formatMessage({ id: "machine.detail.save" })}
            </button>
            <button
              onClick={() => setEditing(false)}
              className="btn-brutal-sm bg-white px-2 py-1 text-xs"
            >
              {formatMessage({ id: "common.confirm.cancel" })}
            </button>
          </div>
        </div>
      ) : hasVars ? (
        <div className="flex flex-wrap gap-2">
          {Object.entries(envVars!).map(([key, value]) => (
            <span
              key={key}
              className="inline-block border-2 border-black bg-white px-2 py-0.5 text-xs font-mono text-black"
              title={`${key}=${value}`}
            >
              {key}=<span className="text-black/40">{"•".repeat(Math.min(value.length, 8))}</span>
            </span>
          ))}
        </div>
      ) : (
        <p className="text-xs italic text-black/40">
          {formatMessage({ id: "agent.detail.noEnvironmentVariables" })}
        </p>
      )}
    </div>
  );
}

// Isolated info bar — role/model/reasoning editing state lives here,
// so keystroke re-renders don't cascade to ChatPanel / tabs below.
/** Profile tab: description, machine, model config, env vars, created date */
function AgentProfileInfo({ agent, canManageAgent, canChangeAgentRole, onOpenProfile, showOperationalInfo = true }: { agent: Agent; canManageAgent: boolean; canChangeAgentRole: boolean; onOpenProfile?: (type: "agent" | "human", id: string) => void; showOperationalInfo?: boolean }) {
  const { formatDate, formatList, formatMessage } = useIntl();
  const formatMessageRef = useRef(formatMessage);
  formatMessageRef.current = formatMessage;
  const updateAgent = useAgentStore((s) => s.updateAgent);
  const fetchExternalAgentStatus = useAgentStore((s) => s.fetchExternalAgentStatus);
  const fetchOnboardingIdentityAdoption = useAgentStore((s) => s.fetchOnboardingIdentityAdoption);
  const adoptOnboardingIdentity = useAgentStore((s) => s.adoptOnboardingIdentity);
  const currentServer = useServerStore((s) => s.current);
  const displayState = useAgentDisplayState(agent.id, agent);
  const machines = useMachineStore((s) => s.machines);
  const nav = useAppNavigate();
  const isExternalAgent = agent.external === true || isExternalAgentRuntime(agent.runtime);
  const { formatShortDateTime } = useTimeFormatter();
  const { role: currentRole, capabilities } = useServerPermissions();
  const currentUserId = useAuthStore((s) => s.user?.id ?? null);

  const machineLoadStatus = useMachineStore((s) => s.loadStatus);
  // task #259: while the store has no snapshot yet the Computer row is not rendered, so it
  // cannot flash "No computer assigned" before flipping to the machine (decision 甲, both ends).
  const agentMachineRow = resolveAgentMachineRow(agent.machineId, machines, machineLoadStatus);
  const agentMachine = agentMachineRow.kind === "machine" ? agentMachineRow.machine : null;
  const machineStatus = agentMachine ? agentMachine.status : agent.machineId ? "offline" : null;
  const displayNameRef = useRef<HTMLInputElement>(null);
  const roleRef = useRef<HTMLTextAreaElement>(null);
  const configRef = useRef<HTMLDivElement>(null);
  const runtimeConfigModalRef = useRef<HTMLDivElement>(null);
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- intentionally recompute only on the runtime-relevant agent fields (envVars/model/reasoningEffort/runtime/runtimeConfig); depending on the whole `agent` would recompute on every unrelated agent update (activity/status/name) and churn the hydrated form.
  const currentRuntimeConfig = useMemo(() => hydrateRuntimeConfigForm(agent), [
    agent.envVars,
    agent.model,
    agent.reasoningEffort,
    agent.runtime,
    agent.runtimeConfig,
  ]);
  const currentRuntimeModel = runtimeConfigModelValue(currentRuntimeConfig);
  // Runtime-config draft buffers. The edit form (L1099 `{editingRuntimeConfig && ...}`)
  // is the ONLY render path that reads these, and `startRuntimeConfigEditing` re-seeds
  // every draft from `currentRuntimeConfig` immediately before flipping the editing
  // flag — so while `!editingRuntimeConfig` the drafts are "garbage but unused" and
  // need not track prop drift. The mount-time initializers are intentional cosmetic
  // defaults; they are never read until the next `startRuntimeConfigEditing` seeds them.
  // Async schema arrival reconciles only a newly selected Kimi runtime draft.
  // oxlint-disable react-doctor/no-event-handler
  const [editingRuntimeConfig, setEditingRuntimeConfig] = useState(false);
  const [draftRuntime, setDraftRuntime] = useState(agent.runtime || "claude");
  const [draftModel, setDraftModel] = useState("");
  const [draftCustomModelMode, setDraftCustomModelMode] = useState(false);
  const [draftProviderMode, setDraftProviderMode] = useState<RuntimeProviderMode>("default");
  const [draftProviderApiUrl, setDraftProviderApiUrl] = useState("");
  const [draftProviderApiKey, setDraftProviderApiKey] = useState("");
  const [draftBuiltInProviderMode, setDraftBuiltInProviderMode] = useState<BuiltInProviderMode>(BUILTIN_RUNTIME_DEFAULT_PROVIDER_ID);
  const [draftBuiltInProviderApiKey, setDraftBuiltInProviderApiKey] = useState("");
  const [draftBuiltInProviderBaseUrl, setDraftBuiltInProviderBaseUrl] = useState("");
  const [draftBuiltInProviderSupportsImageInput, setDraftBuiltInProviderSupportsImageInput] = useState(false);
  const [draftProviderConnectionId, setDraftProviderConnectionId] = useState("");
  const [draftPiProviderMode, setDraftPiProviderMode] = useState<PiProviderMode>(PI_PROVIDER_CONFIGURED);
  const [draftPiProviderApiKey, setDraftPiProviderApiKey] = useState("");
  const [draftFastMode, setDraftFastMode] = useState(false);
  const [draftCommand, setDraftCommand] = useState("");
  const [draftEnvVarEntries, setDraftEnvVarEntries] = useState<{ key: string; value: string }[]>([]);
  const [runtimeConfigAdvancedOpen, setRuntimeConfigAdvancedOpen] = useState(false);
  const [draftReasoningEffort, setDraftReasoningEffort] = useState<RuntimeReasoningEffort | null>(null);
  const [savingRuntimeConfig, setSavingRuntimeConfig] = useState(false);
  const [runtimeConfigSaveError, setRuntimeConfigSaveError] = useState("");
  const [externalStatus, setExternalStatus] = useState<ExternalAgentStatus | null>(null);
  const [externalStatusError, setExternalStatusError] = useState("");
  const [externalCopiedTarget, setExternalCopiedTarget] = useState<string | null>(null);
  const [externalSetupTab, setExternalSetupTab] = useState<ExternalSetupTab>("hermes");
  const effectiveExternalSetupTab = externalSetupTab;
  const openProfile = useProfileStore((s) => s.openProfile);
  const [pendingConfirm, setPendingConfirm] = useState<{
    title: string;
    message: ReactNode;
    confirmLabel: string;
    loadingLabel: string;
    confirmColor: string;
    plainMessage?: boolean;
    maxWidthClass?: string;
    onConfirm: () => Promise<void>;
  } | null>(null);
  const isActive = displayState.isOnline || agent.status === "active";
  const activeRuntime = editingRuntimeConfig ? draftRuntime : currentRuntimeConfig.runtime;
  const runtimeModels = useRuntimeModels(agent.machineId, activeRuntime);
  const currentRuntimeModelPresentation = activeRuntime === currentRuntimeConfig.runtime
    ? projectRuntimeModelLabelPresentation(currentRuntimeConfig.runtime, currentRuntimeModel, runtimeModels)
    : { kind: "resolved" as const, label: getModelLabel(currentRuntimeConfig.runtime, currentRuntimeModel) };
  const currentRuntimeModelLabel = currentRuntimeModelPresentation.kind === "pending"
    ? formatMessage({ id: "common.loading" })
    : currentRuntimeModelPresentation.label;
  const availableRuntimes = agentMachine?.runtimes || [];
  // Gated on the same flag that governs display, so the loader and the surface
  // cannot drift apart: a remote joint agent shows no operational info and must
  // therefore not trigger this server's private runtime-options fetch either.
  const { options: runtimeAdmissionOptions } = useExistingAgentRuntimeSelectionOptions(
    agent.id,
    availableRuntimes,
    showOperationalInfo,
  );
  const runtimeFormDefinitionRefs = useMemo(
    () => runtimeAdmissionOptions.flatMap((option): RuntimeFormDefinitionRef[] =>
      option.canSelectInThisContext && option.formDefinitionRef ? [option.formDefinitionRef] : []),
    [runtimeAdmissionOptions],
  );
  const runtimeFormDefinitionCatalog = useRuntimeFormDefinitionCatalog(
    showOperationalInfo ? agent.machineId : null,
    runtimeFormDefinitionRefs,
  );
  const draftRuntimeAdmission = runtimeAdmissionOptions.find((option) => option.runtimeId === draftRuntime);
  const draftFormDefinitionRef = draftRuntimeAdmission?.formDefinitionRef;
  const draftFormDefinitionEntry = draftFormDefinitionRef
    ? runtimeFormDefinitionCatalog.entries[runtimeFormDefinitionRefKey(draftFormDefinitionRef)]
    : undefined;
  // Built-in edit keeps its established writeOnly-secret retention path. Kimi
  // has no writeOnly field and uses the same schema renderer on create/edit.
  const draftSchemaBacked = draftRuntime === "kimi-sdk" && draftFormDefinitionRef !== undefined;
  const draftFormDefinition = draftSchemaBacked ? draftFormDefinitionEntry?.definition ?? null : null;
  const draftSchemaModelSource = draftFormDefinition?.optionSources.model?.kind === "select"
    ? draftFormDefinition.optionSources.model
    : null;
  // The definition arrives asynchronously after the explicit runtime-change
  // event. Reconcile only that new-runtime draft; existing Kimi values remain
  // visible even when the fresh live source no longer accepts them.
  // oxlint-disable-next-line react-doctor/no-cascading-set-state, react-doctor/no-effect-chain, react-doctor/no-event-handler
  useEffect(() => {
    if (
      !editingRuntimeConfig
      || draftRuntime !== "kimi-sdk"
      || currentRuntimeConfig.runtime === "kimi-sdk"
      || !draftSchemaModelSource
    ) return;
    const selected = draftSchemaModelSource.options.find((option) => option.value === draftModel)
      ?? draftSchemaModelSource.options.find((option) => option.value === draftSchemaModelSource.defaultValue)
      ?? draftSchemaModelSource.options[0];
    if (!selected) return;
    // oxlint-disable-next-line react-doctor/no-derived-state
    if (selected.value !== draftModel) setDraftModel(selected.value);
    const supported = selected.supportedReasoningEfforts ?? [];
    if (draftReasoningEffort !== null && supported.includes(draftReasoningEffort)) return;
    // oxlint-disable-next-line react-doctor/no-derived-state
    setDraftReasoningEffort(selected.defaultReasoningEffort ?? null);
  }, [
    currentRuntimeConfig.runtime,
    draftModel,
    draftReasoningEffort,
    draftRuntime,
    draftSchemaModelSource,
    editingRuntimeConfig,
  ]);
  // oxlint-enable react-doctor/no-event-handler
  const currentRuntimeDeprecated = isRuntimeDeprecated(currentRuntimeConfig.runtime);
  const canViewRuntimeAccountUsage = showOperationalInfo
    && canViewMachineRuntimeAccountUsage(agentMachine, currentUserId, capabilities);
  const providerConnectionCatalog = useProviderConnections(canManageAgent);
  const currentProviderConnectionId = runtimeConfigProviderConnectionId(currentRuntimeConfig);
  const selectedProviderConnection = providerConnectionCatalog.connections.find(
    (connection) => connection.id === draftProviderConnectionId,
  ) ?? null;
  const managedConnectionActive = draftRuntime === "builtin" && Boolean(draftProviderConnectionId);
  const providerConnectionInvalid = managedConnectionActive
    && (
      !providerConnectionCatalog.featureEnabled
      || !selectedProviderConnection
      || !selectedProviderConnection.enabled
      || selectedProviderConnection.status !== "ready"
    );
  const existingRuntimeInfo = getExistingAgentRuntimeOptions(currentRuntimeConfig.runtime);
  const runtimeOptions = runtimeAdmissionOptions.flatMap((option) => {
    const runtimeInfo = existingRuntimeInfo.find((runtime) => runtime.id === option.runtimeId);
    return runtimeInfo
      ? [{
          value: runtimeInfo.id,
          label: formatRuntimeLabelWithStatus(runtimeInfo.id, formatMessage) + formatRuntimeAvailabilitySuffix(runtimeAvailabilitySuffix(runtimeInfo, availableRuntimes), formatMessage),
          disabled: !option.canSelectInThisContext,
        }]
      : [];
  });
  const draftRuntimeCanSelect = runtimeAdmissionOptions
    .find((option) => option.runtimeId === draftRuntime)
    ?.canSelectInThisContext === true;

  const [editingDisplayName, setEditingDisplayName] = useState(false);
  const [displayNameValue, setDisplayNameValue] = useState(agent.displayName || "");
  const [displayNameError, setDisplayNameError] = useState("");
  const [savingDisplayName, setSavingDisplayName] = useState(false);
  const [editingRole, setEditingRole] = useState(false);
  const [roleValue, setRoleValue] = useState(agent.description || "");
  const [roleError, setRoleError] = useState("");
  const [savingRole, setSavingRole] = useState(false);
  const [editingServerRole, setEditingServerRole] = useState(false);
  const [serverRoleValue, setServerRoleValue] = useState<Extract<ServerRole, "admin" | "member">>(agent.serverRole === "admin" ? "admin" : "member");
  const [serverRolePickerOpen, setServerRolePickerOpen] = useState(false);
  const [serverRoleSaving, setServerRoleSaving] = useState(false);
  const [serverRoleError, setServerRoleError] = useState("");
  const [showRoleHelp, setShowRoleHelp] = useState(false);
  const [onboardingIdentityState, setOnboardingIdentityState] = useState<{
    agentId: string | null;
    preview: OnboardingIdentityAdoptionPreview | null;
    error: string;
  }>({ agentId: null, preview: null, error: "" });
  const isCurrentServerOnboardingAgent = Boolean(
    canManageAgent
    && showOperationalInfo
    && currentServer?.onboardingAgentId
    && currentServer.onboardingAgentId === agent.id,
  );

  const externalProfileSlug = agent.name.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || agent.id.slice(0, 8);
  const externalLoginCommand = `raft agent login --server ${getServerUrl()} --agent ${agent.id} --profile-slug ${externalProfileSlug}`;
  const externalCliInstallCommand = "npm i -g @botiverse/raft@latest";
  const externalClaudeSessionPrompt = formatMessage({ id: "agent.externalSetup.connectedPrompt" });
  const externalClaudeStartCommand = [
    `RAFT_EXPECTED_AGENT_ID=${agent.id} RAFT_PROFILE=${externalProfileSlug} claude \\`,
    `  --append-system-prompt '${externalClaudeSessionPrompt}' \\`,
    "  --dangerously-load-development-channels plugin:raft-channel@raft",
  ].join("\n");
  const externalClaudeSetupSteps = [
    {
      title: formatMessage({ id: "agent.detail.externalClaudeInstallTitle" }),
      command: [
        externalCliInstallCommand,
        "claude plugin marketplace add botiverse/raft-external-agents",
        "claude plugin marketplace update raft",
        "claude plugin install raft-channel@raft",
        "claude plugin update raft-channel@raft",
      ].join(" && "),
      description: "",
    },
    {
      title: formatMessage({ id: "agent.detail.externalLoginProfileTitle" }),
      command: externalLoginCommand,
      description: formatMessage({ id: "agent.detail.externalTokenLogin" }),
    },
    {
      title: formatMessage({ id: "agent.detail.externalClaudeStartTitle" }),
      command: externalClaudeStartCommand,
      description: "",
    },
  ];
  const externalClaudeSetupInstruction = externalClaudeSetupSteps
    .map((step, idx) => `${formatMessage({ id: "agent.detail.stepNumber" }, { step: idx + 1 })}: ${step.title}\n${step.command}`)
    .join("\n\n");
  const externalHermesSetupSteps = [
    {
      title: formatMessage({ id: "agent.detail.externalInstallRaftCliTitle" }),
      command: externalCliInstallCommand,
      description: formatMessage({ id: "agent.detail.externalHermesInstallDescription" }),
    },
    {
      title: formatMessage({ id: "agent.detail.externalLoginProfileTitle" }),
      command: externalLoginCommand,
      description: formatMessage({ id: "agent.detail.externalTokenLogin" }),
    },
    {
      title: formatMessage({ id: "agent.detail.externalHermesConfigureTitle" }),
      command: `RAFT_EXPECTED_AGENT_ID=${agent.id} hermes gateway setup`,
      description: formatMessage(
        { id: "agent.detail.externalHermesConfigureDescription" },
        { slug: externalProfileSlug, agentId: agent.id },
      ),
    },
  ];
  const externalHermesSetupInstruction = externalHermesSetupSteps
    .map((step, idx) => `${formatMessage({ id: "agent.detail.stepNumber" }, { step: idx + 1 })}: ${step.title}\n${step.command}`)
    .join("\n\n");
  const externalOtherSetupInstruction = [
    formatMessage({ id: "agent.detail.externalOtherRunInSession" }),
    "",
    externalCliInstallCommand,
    externalLoginCommand,
    "",
    formatMessage({ id: "agent.detail.externalTokenLogin" }),
    "",
    formatMessage({ id: "agent.detail.externalOtherReviewGuide" }, { slug: externalProfileSlug }),
  ].join("\n");
  const activeExternalSetupInstruction = effectiveExternalSetupTab === "claude-code"
    ? externalClaudeSetupInstruction
    : effectiveExternalSetupTab === "hermes"
      ? externalHermesSetupInstruction
      : externalOtherSetupInstruction;
  const externalSetupInstruction = activeExternalSetupInstruction;
  const externalStepSetupSteps = effectiveExternalSetupTab === "claude-code"
    ? externalClaudeSetupSteps
    : effectiveExternalSetupTab === "hermes"
      ? externalHermesSetupSteps
      : null;
  const currentAgentServerRole = agent.serverRole === "admin" ? "admin" : agent.serverRole === "member" ? "member" : null;
  const editableAgentRoleOptions = useMemo(
    () => currentAgentServerRole
      ? EDITABLE_AGENT_ROLE_OPTIONS
        .filter((option) => canChangeMemberRole(currentRole, currentAgentServerRole, option.id))
        .map((option) => ({
          id: option.id,
          label: formatMessage({ id: option.labelId }),
        }))
      : [],
    [currentAgentServerRole, currentRole, formatMessage],
  );
  const canEditServerRole = canChangeAgentRole && currentAgentServerRole !== null && editableAgentRoleOptions.length > 0;
  const currentAgentServerRoleInfo = currentAgentServerRole ? AGENT_ROLE_CONFIG[currentAgentServerRole] : null;
  // task #261: unrecognized role -> show the name the server sent; no role / deleted -> no chip.
  const serverRoleDisplay = resolveAgentServerRoleDisplay(agent.serverRole, agent.deletedAt);

  useEffect(() => {
    if (!isCurrentServerOnboardingAgent) return;
    let canceled = false;
    void fetchOnboardingIdentityAdoption(agent.id)
      .then((preview) => {
        if (!canceled) setOnboardingIdentityState({ agentId: agent.id, preview, error: "" });
      })
      .catch((err: unknown) => {
        const axiosErr = err as { response?: { data?: { error?: string } } };
        if (!canceled) setOnboardingIdentityState({
          agentId: agent.id,
          preview: null,
          error: axiosErr.response?.data?.error || formatMessageRef.current({ id: "agent.detail.loadOfficialIdentityFailed" }),
        });
      });
    return () => {
      canceled = true;
    };
  }, [agent.avatarUrl, agent.description, agent.displayName, agent.id, agent.name, fetchOnboardingIdentityAdoption, isCurrentServerOnboardingAgent]);

  useEffect(() => {
    if (!isExternalAgent || !canManageAgent) return;
    let canceled = false;
    const loadExternalStatus = async () => {
      setExternalStatusError("");
      try {
        const status = await fetchExternalAgentStatus(agent.id);
        if (!canceled) setExternalStatus(status);
      } catch (err: unknown) {
        const axiosErr = err as { response?: { data?: { error?: string } } };
        if (!canceled) setExternalStatusError(axiosErr.response?.data?.error || formatMessageRef.current({ id: "agent.detail.loadExternalSetupStatusFailed" }));
      }
    };
    void loadExternalStatus();
    return () => {
      canceled = true;
    };
  }, [agent.id, canManageAgent, fetchExternalAgentStatus, isExternalAgent]);

  const handleCopyExternalCommand = async (text = externalSetupInstruction, target = "setup") => {
    await copyTextToClipboard(text);
    setExternalCopiedTarget(target);
    window.setTimeout(() => setExternalCopiedTarget(null), 2000);
  };

  const autoResizeTextarea = useCallback((el: HTMLTextAreaElement | null) => {
    if (!el) return;
    el.style.height = "auto";
    const minH = parseFloat(getComputedStyle(el).minHeight) || 0;
    el.style.height = `${Math.max(Math.min(el.scrollHeight, 160), minH)}px`;
  }, []);

  useEffect(() => {
    // oxlint-disable-next-line react-doctor/no-event-handler -- YMNNE-family: pre-existing non-bug site grandfathered; rule now gates new code (see docs/frontend/render-cost-contract.md)
    if (editingRole) autoResizeTextarea(roleRef.current);
  }, [editingRole, roleValue, autoResizeTextarea]);

  const handleSaveDisplayName = async () => {
    const nextDisplayName = displayNameValue.trim();
    setDisplayNameError("");
    setSavingDisplayName(true);
    try {
      await updateAgent(agent.id, {
        displayName: nextDisplayName || null,
      });
      setEditingDisplayName(false);
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: { error?: string } } };
      setDisplayNameError(axiosErr.response?.data?.error || formatMessage({ id: "agent.detail.updateDisplayNameFailed" }));
    } finally {
      setSavingDisplayName(false);
    }
  };

  const handleSaveRole = async () => {
    const nextDescription = roleValue.trim();
    if (nextDescription.length > MAX_AGENT_DESCRIPTION_LENGTH) {
      setRoleError(formatMessage({ id: "agent.detail.descriptionMaxLength" }, { count: MAX_AGENT_DESCRIPTION_LENGTH }));
      return;
    }
    setRoleError("");
    setSavingRole(true);
    try {
      await updateAgent(agent.id, {
        description: nextDescription || null,
      });
      setEditingRole(false);
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: { error?: string } } };
      setRoleError(axiosErr.response?.data?.error || formatMessage({ id: "agent.detail.updateDescriptionFailed" }));
    } finally {
      setSavingRole(false);
    }
  };

  const handleSaveServerRole = async () => {
    if (!currentAgentServerRole || serverRoleValue === currentAgentServerRole) {
      setEditingServerRole(false);
      return;
    }
    setServerRoleError("");
    setServerRoleSaving(true);
    try {
      await updateAgent(agent.id, {
        serverRole: serverRoleValue,
      });
      setEditingServerRole(false);
      setServerRolePickerOpen(false);
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: { error?: string } } };
      setServerRoleError(axiosErr.response?.data?.error || formatMessage({ id: "agent.detail.updateRoleFailed" }));
    } finally {
      setServerRoleSaving(false);
    }
  };

  const formatIdentityValue = (value: string | null) => value && value.trim()
    ? value
    : formatMessage({ id: "agent.detail.blank" });
  const currentOnboardingIdentityPreview = onboardingIdentityState.agentId === agent.id ? onboardingIdentityState.preview : null;
  const currentOnboardingIdentityError = onboardingIdentityState.agentId === agent.id ? onboardingIdentityState.error : "";

  const handleAdoptOnboardingIdentity = () => {
    const onboardingIdentityPreview = currentOnboardingIdentityPreview;
    if (!onboardingIdentityPreview || onboardingIdentityPreview.changes.length === 0) return;
    const grantsServerAdmin = onboardingIdentityPreview.changes.some(
      (change) => change.field === "serverRole" && change.after === "admin",
    );
    requestConfirm({
      title: grantsServerAdmin
        ? formatMessage({ id: "agent.detail.updateIdentityAndAdminRole" })
        : formatMessage({ id: "agent.detail.updateOfficialIdentity" }),
      message: (
        <div className="space-y-4">
          <p className="text-sm text-black/60">
            {formatMessage({ id: "agent.detail.reviewOfficialIdentityChanges" })}
          </p>
          <dl className="divide-y divide-black/10">
            {onboardingIdentityPreview.changes.map((change) => (
              <div
                key={change.field}
                data-onboarding-identity-change={change.field}
                className="grid grid-cols-[96px_minmax(0,1fr)] items-baseline gap-3 py-3 first:pt-0 last:pb-0"
              >
                <dt className="text-xs font-bold uppercase tracking-wide text-black/50">{change.label}</dt>
                <dd className="flex min-w-0 items-center gap-2 font-mono text-sm">
                  <span className="min-w-0 break-words text-black/50">{formatIdentityValue(change.before)}</span>
                  <MoveRight aria-hidden="true" size={16} className="shrink-0 text-black/30" />
                  <span className="min-w-0 break-words font-bold text-black">{formatIdentityValue(change.after)}</span>
                </dd>
              </div>
            ))}
          </dl>
          {grantsServerAdmin && (
            <Banner intent="warning" withIcon>
              {formatMessage({ id: "agent.detail.grantsAdminWarning" })}
            </Banner>
          )}
          <p className="text-xs text-black/50">{formatMessage({ id: "agent.detail.customizeAfterIdentityUpdate" })}</p>
        </div>
      ),
      confirmLabel: grantsServerAdmin
        ? formatMessage({ id: "agent.detail.updateIdentityAndRole" })
        : formatMessage({ id: "agent.detail.updateIdentity" }),
      loadingLabel: formatMessage({ id: "agent.detail.updating" }),
      confirmColor: "bg-brutal-pink",
      plainMessage: true,
      maxWidthClass: "max-w-md",
      onConfirm: async () => {
        const result = await adoptOnboardingIdentity(agent.id);
        setOnboardingIdentityState({ agentId: agent.id, preview: result, error: "" });
      },
    });
  };

  const createdDate = formatDate(agent.createdAt, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

  const closeRuntimeConfigEditor = () => {
    setEditingRuntimeConfig(false);
    setRuntimeConfigSaveError("");
    setDraftRuntime(currentRuntimeConfig.runtime);
    setDraftModel(currentRuntimeModel);
    setDraftCustomModelMode(currentRuntimeConfig.model.kind === "custom");
    setDraftProviderMode(runtimeConfigProviderMode(currentRuntimeConfig));
    setDraftProviderApiUrl(runtimeConfigApiUrl(currentRuntimeConfig));
    setDraftProviderApiKey(runtimeConfigApiKey(currentRuntimeConfig));
    setDraftBuiltInProviderMode(runtimeConfigBuiltInProviderMode(currentRuntimeConfig));
    setDraftBuiltInProviderApiKey(runtimeConfigBuiltInProviderApiKey(currentRuntimeConfig));
    setDraftBuiltInProviderBaseUrl(runtimeConfigBuiltInProviderBaseUrl(currentRuntimeConfig));
    setDraftBuiltInProviderSupportsImageInput(runtimeConfigBuiltInProviderSupportsImageInput(currentRuntimeConfig));
    setDraftProviderConnectionId(currentProviderConnectionId);
    setDraftPiProviderMode(runtimeConfigPiProviderMode(currentRuntimeConfig));
    setDraftPiProviderApiKey(runtimeConfigPiProviderApiKey(currentRuntimeConfig));
    setDraftFastMode(runtimeConfigFastMode(currentRuntimeConfig));
    setDraftCommand(runtimeConfigCommand(currentRuntimeConfig));
    setDraftEnvVarEntries(
      currentRuntimeConfig.envVars
        ? Object.entries(currentRuntimeConfig.envVars).map(([key, value]) => ({ key, value }))
        : [],
    );
    setRuntimeConfigAdvancedOpen(false);
    setDraftReasoningEffort(currentRuntimeConfig.reasoningEffort ?? null);
  };

  const requestConfirm = (config: {
    title: string;
    message: ReactNode;
    confirmLabel: string;
    loadingLabel: string;
    confirmColor: string;
    plainMessage?: boolean;
    maxWidthClass?: string;
    onConfirm: () => Promise<void>;
  }) => {
    closeRuntimeConfigEditor();
    setPendingConfirm(config);
  };

  const draftSupportsReasoning = REASONING_EFFORT_RUNTIMES.has(draftRuntime)
    && (draftRuntime !== "kimi-sdk" || draftSchemaBacked);
  const legacyKimiReasoningRequiresUpgrade = draftRuntime === "kimi-sdk"
    && !draftSchemaBacked
    && currentRuntimeConfig.runtime === "kimi-sdk"
    && currentRuntimeConfig.reasoningEffort !== null
    && draftModel !== currentRuntimeModel;
  const reasoningDisplayValue = draftReasoningEffort || formatMessage({ id: "agent.runtimeConfig.default" });
  const draftSupportsApiUrl = supportsRuntimeApiUrl(draftRuntime);
  const draftSupportsFastMode = supportsRuntimeFastMode(draftRuntime);
  const currentProviderApiUrl = runtimeConfigApiUrl(currentRuntimeConfig);
  const currentProviderApiKey = runtimeConfigApiKey(currentRuntimeConfig);
  const currentBuiltInProviderMode = runtimeConfigBuiltInProviderMode(currentRuntimeConfig);
  const currentBuiltInProviderApiKey = runtimeConfigBuiltInProviderApiKey(currentRuntimeConfig);
  const currentBuiltInProviderBaseUrl = runtimeConfigBuiltInProviderBaseUrl(currentRuntimeConfig);
  const currentBuiltInProviderSupportsImageInput = runtimeConfigBuiltInProviderSupportsImageInput(currentRuntimeConfig);
  const currentPiProviderMode = runtimeConfigPiProviderMode(currentRuntimeConfig);
  const currentPiProviderApiKey = runtimeConfigPiProviderApiKey(currentRuntimeConfig);
  const currentCustomModelMode = currentRuntimeConfig.model.kind === "custom";
  const currentProviderMode = runtimeConfigProviderMode(currentRuntimeConfig);
  const currentFastMode = runtimeConfigFastMode(currentRuntimeConfig);
  const currentCommand = runtimeConfigCommand(currentRuntimeConfig);
  const draftProviderApiUrlRequired = draftSupportsApiUrl && draftProviderMode === "custom";
  const draftProviderApiUrlInvalid = draftProviderApiUrlRequired
    ? !/^https?:\/\//i.test(draftProviderApiUrl.trim())
    : draftProviderApiUrl.trim().length > 0 && !/^https?:\/\//i.test(draftProviderApiUrl.trim());
  const draftProviderApiKeyInvalid = draftProviderApiUrlRequired && !draftProviderApiKey.trim();
  const draftRetainsBuiltInProviderApiKey = supportsRuntimeBuiltInProvider(draftRuntime)
    && currentRuntimeConfig.runtime === "builtin"
    && draftRuntime === "builtin"
    && draftBuiltInProviderMode === currentBuiltInProviderMode
    && (
      !isBuiltInGatewayProviderMode(draftBuiltInProviderMode)
      || draftBuiltInProviderBaseUrl.trim() === currentBuiltInProviderBaseUrl.trim()
    )
    && !draftBuiltInProviderApiKey.trim();
  const draftBuiltInProviderApiKeyInvalid = isBuiltInProviderApiKeyInvalid({
    builtInProviderSupported: supportsRuntimeBuiltInProvider(draftRuntime),
    managedConnectionActive,
    apiKey: draftBuiltInProviderApiKey,
    retainsExistingKey: draftRetainsBuiltInProviderApiKey,
  });
  const draftPiProviderApiKeyInvalid = supportsRuntimePiProvider(draftRuntime)
    && draftPiProviderMode !== PI_PROVIDER_CONFIGURED
    && !draftPiProviderApiKey.trim();
  const draftBuiltInProviderBaseUrlRequired = supportsRuntimeBuiltInProvider(draftRuntime)
    && !managedConnectionActive
    && isBuiltInGatewayProviderMode(draftBuiltInProviderMode);
  const draftBuiltInProviderBaseUrlInvalid = draftBuiltInProviderBaseUrlRequired && !/^https?:\/\//i.test(draftBuiltInProviderBaseUrl.trim());
  const draftConnectionGateway = selectedProviderConnection
    ? isBuiltInGatewayProviderMode(selectedProviderConnection.providerId)
    : false;
  const draftCustomModelInvalid = (draftCustomModelMode || draftBuiltInProviderBaseUrlRequired || draftConnectionGateway) && !draftModel.trim();
  const draftSchemaSelectedModel = draftSchemaModelSource?.options.find((option) => option.value === draftModel);
  const draftRetainsBuiltInPresetSelection =
    currentRuntimeConfig.runtime === "builtin" &&
    draftRuntime === "builtin" &&
    !isBuiltInGatewayProviderMode(currentBuiltInProviderMode) &&
    draftBuiltInProviderMode === currentBuiltInProviderMode &&
    draftModel === currentRuntimeModel &&
    !draftCustomModelMode;
  const draftSchemaEffortInvalid = draftSchemaBacked
    && draftReasoningEffort !== null
    && !(draftSchemaSelectedModel?.supportedReasoningEfforts ?? []).includes(draftReasoningEffort);
  const draftModelSourceInvalid = draftSchemaBacked
    ? !draftSchemaSelectedModel || draftSchemaEffortInvalid
    : !runtimeModelSelectionIsRunnable({
        source: runtimeModels.source,
        model: draftModel,
        modelIgnored: runtimeIgnoresModel(draftRuntime),
        customMode: draftCustomModelMode,
        customAllowed: supportsRuntimeCustomModelName(draftRuntime),
        providerCatalog: draftRuntime === "pi" && draftPiProviderMode !== PI_PROVIDER_CONFIGURED,
        persistedModel: draftRetainsBuiltInPresetSelection ? currentRuntimeModel : undefined,
        requireBuiltInCatalog:
          supportsRuntimeBuiltInProvider(draftRuntime) &&
          !draftBuiltInProviderBaseUrlRequired,
      });
  const draftEnvVars = useMemo(() => {
    const next: Record<string, string> = {};
    for (const entry of draftEnvVarEntries) {
      const key = entry.key.trim();
      if (key) next[key] = entry.value;
    }
    return Object.keys(next).length > 0 ? next : null;
  }, [draftEnvVarEntries]);
  const currentEnvVarsJson = JSON.stringify(currentRuntimeConfig.envVars ?? null);
  const draftEnvVarsJson = JSON.stringify(draftEnvVars);
  const runtimeConfigChanged =
    draftRuntime !== currentRuntimeConfig.runtime
    || draftModel !== currentRuntimeModel
    || draftCustomModelMode !== currentCustomModelMode
    || draftProviderMode !== currentProviderMode
    || draftProviderApiUrl.trim() !== currentProviderApiUrl
    || draftProviderApiKey.trim() !== currentProviderApiKey
    || draftBuiltInProviderMode !== currentBuiltInProviderMode
    || draftBuiltInProviderApiKey.trim() !== currentBuiltInProviderApiKey
    || draftBuiltInProviderBaseUrl.trim() !== currentBuiltInProviderBaseUrl
    || draftBuiltInProviderSupportsImageInput !== currentBuiltInProviderSupportsImageInput
    || draftProviderConnectionId !== currentProviderConnectionId
    || draftPiProviderMode !== currentPiProviderMode
    || draftPiProviderApiKey.trim() !== currentPiProviderApiKey
    || draftFastMode !== currentFastMode
    || draftCommand.trim() !== currentCommand
    || (draftReasoningEffort ?? null) !== (currentRuntimeConfig.reasoningEffort ?? null)
    || draftEnvVarsJson !== currentEnvVarsJson;
  const runtimeConfigSaveDisabled = isRuntimeConfigSaveDisabled({
    saving: savingRuntimeConfig,
    changed: runtimeConfigChanged,
    runtimeCanSelect: draftRuntimeCanSelect,
    providerConnectionInvalid,
    providerApiUrlInvalid: draftProviderApiUrlInvalid,
    providerApiKeyInvalid: draftProviderApiKeyInvalid,
    builtInProviderApiKeyInvalid: draftBuiltInProviderApiKeyInvalid,
    piProviderApiKeyInvalid: draftPiProviderApiKeyInvalid,
    builtInProviderBaseUrlInvalid: draftBuiltInProviderBaseUrlInvalid,
    customModelInvalid: draftCustomModelInvalid,
    modelSourceInvalid: draftModelSourceInvalid || legacyKimiReasoningRequiresUpgrade,
  });
  const modelOptions = (() => {
    const options = runtimeModels.models.map((m) => ({ value: m.id, label: m.label }));
    if (runtimeModels.source.kind === "live" && !draftCustomModelMode && draftModel && !options.some((option) => option.value === draftModel)) {
      options.push({
        value: draftModel,
        label: formatMessage(
          { id: "agent.detail.modelNotInComputerConfig" },
          { model: getModelLabel(draftRuntime, draftModel) },
        ),
      });
    }
    return options;
  })();
  const draftModelInfo = runtimeModels.models.find((m) => m.id === draftModel);
  const draftModelSuggestionOnly = draftModelInfo?.verified === "suggestion_only";

  // Change the drafted model and reconcile reasoning against the new model's
  // declared supportedReasoningEfforts (e.g. switching to GPT-5.6 luna drops an
  // Ultra selection down to Medium).
  const changeDraftModel = (nextModel: string) => {
    setDraftModel(nextModel);
    if (draftRuntime !== "kimi-sdk") {
      setDraftReasoningEffort((prev) => reconcileReasoningEffort(
        draftRuntime,
        nextModel,
        prev as ReasoningEffort | null,
        runtimeModels.models,
      ));
    }
  };

  const startRuntimeConfigEditing = () => {
    setRuntimeConfigSaveError("");
    setDraftRuntime(currentRuntimeConfig.runtime);
    setDraftModel(currentRuntimeModel);
    setDraftCustomModelMode(currentRuntimeConfig.model.kind === "custom");
    setDraftProviderMode(runtimeConfigProviderMode(currentRuntimeConfig));
    setDraftProviderApiUrl(runtimeConfigApiUrl(currentRuntimeConfig));
    setDraftProviderApiKey(runtimeConfigApiKey(currentRuntimeConfig));
    setDraftBuiltInProviderMode(runtimeConfigBuiltInProviderMode(currentRuntimeConfig));
    setDraftBuiltInProviderApiKey(runtimeConfigBuiltInProviderApiKey(currentRuntimeConfig));
    setDraftBuiltInProviderBaseUrl(runtimeConfigBuiltInProviderBaseUrl(currentRuntimeConfig));
    setDraftBuiltInProviderSupportsImageInput(runtimeConfigBuiltInProviderSupportsImageInput(currentRuntimeConfig));
    setDraftProviderConnectionId(currentProviderConnectionId);
    setDraftPiProviderMode(runtimeConfigPiProviderMode(currentRuntimeConfig));
    setDraftPiProviderApiKey(runtimeConfigPiProviderApiKey(currentRuntimeConfig));
    setDraftFastMode(runtimeConfigFastMode(currentRuntimeConfig));
    setDraftCommand(runtimeConfigCommand(currentRuntimeConfig));
    setDraftEnvVarEntries(
      currentRuntimeConfig.envVars
        ? Object.entries(currentRuntimeConfig.envVars).map(([key, value]) => ({ key, value }))
        : [],
    );
    setRuntimeConfigAdvancedOpen(false);
    setDraftReasoningEffort(currentRuntimeConfig.reasoningEffort ?? null);
    setEditingRuntimeConfig(true);
  };

  const saveRuntimeConfiguration = async (
    nextConfig: {
      runtime: string;
      model: string;
      runtimeConfig: RuntimeConfig;
      reasoningEffort?: ReasoningEffort | null;
      formDefinitionRef?: RuntimeFormDefinitionRef;
    },
    restartMode?: "restart" | "session",
  ) => {
    await updateAgent(
      agent.id,
      {
        runtime: nextConfig.runtime,
        model: nextConfig.model,
        runtimeConfig: nextConfig.runtimeConfig,
        ...(nextConfig.reasoningEffort !== undefined
          ? { reasoningEffort: nextConfig.reasoningEffort }
          : {}),
        ...(nextConfig.formDefinitionRef ? { formDefinitionRef: nextConfig.formDefinitionRef } : {}),
      },
      restartMode ? { restartMode } : undefined,
    );
  };

  const handleSaveRuntimeConfiguration = async () => {
    setRuntimeConfigSaveError("");
    if (!runtimeConfigChanged) {
      closeRuntimeConfigEditor();
      return;
    }

    if (runtimeConfigSaveDisabled) return;

    const currentRuntime = currentRuntimeConfig.runtime;
    const runtimeChanged = draftRuntime !== currentRuntime;
    const modelChanged = draftModel !== currentRuntimeModel;
    const customModelModeChanged = draftCustomModelMode !== currentCustomModelMode;
    const providerChanged = draftProviderMode !== currentProviderMode
      || draftProviderApiUrl.trim() !== currentProviderApiUrl
      || draftProviderApiKey.trim() !== currentProviderApiKey
      || draftBuiltInProviderMode !== currentBuiltInProviderMode
      || draftBuiltInProviderApiKey.trim() !== currentBuiltInProviderApiKey
      || draftBuiltInProviderBaseUrl.trim() !== currentBuiltInProviderBaseUrl
      || draftBuiltInProviderSupportsImageInput !== currentBuiltInProviderSupportsImageInput
      || draftProviderConnectionId !== currentProviderConnectionId
      || draftPiProviderMode !== currentPiProviderMode
      || draftPiProviderApiKey.trim() !== currentPiProviderApiKey;
    const fastModeChanged = draftFastMode !== currentFastMode;
    const commandChanged = draftCommand.trim() !== currentCommand;
    const reasoningChanged = (draftReasoningEffort ?? null) !== (currentRuntimeConfig.reasoningEffort ?? null);
    const envVarsChanged = draftEnvVarsJson !== currentEnvVarsJson;
    const nextReasoningLabel = draftSupportsReasoning
      ? reasoningDisplayValue
      : formatMessage({ id: "agent.detail.notAvailable" });
    const nextModeLabel = draftSupportsFastMode && draftFastMode
      ? formatMessage({ id: "agent.detail.inFastMode" })
      : "";
    let nextRuntimeConfig: RuntimeConfig;
    try {
      const builtRuntimeConfig = draftSchemaBacked && draftFormDefinition
        ? buildSchemaDrivenKimiConfig({
            definition: draftFormDefinition,
            model: draftModel,
            reasoningEffort: draftReasoningEffort,
            envVars: draftEnvVars,
          })
        : managedConnectionActive && selectedProviderConnection
        ? buildManagedConnectionRuntimeConfig({
            connectionId: selectedProviderConnection.id,
            providerId: selectedProviderConnection.providerId,
            model: draftModel,
            envVars: draftEnvVars,
          })
        : buildRuntimeConfig({
        runtime: draftRuntime,
        model: draftModel,
        customModelMode: draftCustomModelMode,
        customModelName: draftCustomModelMode ? draftModel : undefined,
        providerMode: draftProviderMode,
        providerApiUrl: draftProviderApiUrl,
        providerApiKey: draftProviderApiKey,
        builtInProviderMode: draftBuiltInProviderMode,
        // A placeholder only satisfies the local pure builder. It is removed
        // from the request immediately below; the server alone retains the
        // existing writeOnly value after checking provider identity.
        builtInProviderApiKey: draftRetainsBuiltInProviderApiKey
          ? "retained-by-server"
          : draftBuiltInProviderApiKey,
        builtInProviderBaseUrl: draftBuiltInProviderBaseUrl,
        builtInProviderSupportsImageInput: draftBuiltInProviderSupportsImageInput,
        piProviderMode: draftPiProviderMode,
        piProviderApiKey: draftPiProviderApiKey,
        fastMode: draftSupportsFastMode ? draftFastMode : false,
        reasoningEffort: draftSupportsReasoning ? draftReasoningEffort as ReasoningEffort | null : null,
        envVars: draftEnvVars,
        command: draftCommand,
          });
      const legacyCompatibleRuntimeConfig = draftRuntime === "kimi-sdk" && !draftSchemaBacked
        ? (() => {
            const { reasoningEffort: _unmanagedReasoningEffort, ...configWithoutReasoningEffort } = builtRuntimeConfig;
            return configWithoutReasoningEffort as RuntimeConfig;
          })()
        : builtRuntimeConfig;
      if (
        draftRetainsBuiltInProviderApiKey
        && legacyCompatibleRuntimeConfig.runtime === "builtin"
        && legacyCompatibleRuntimeConfig.provider.kind !== "connection"
      ) {
        const { apiKey: _writeOnly, ...providerWithoutSecret } = legacyCompatibleRuntimeConfig.provider;
        nextRuntimeConfig = {
          ...legacyCompatibleRuntimeConfig,
          provider: providerWithoutSecret,
        } as RuntimeConfig;
      } else {
        nextRuntimeConfig = legacyCompatibleRuntimeConfig;
      }
    } catch (error: unknown) {
      setRuntimeConfigSaveError(
        error instanceof RuntimeConfigBuildError
          ? formatRuntimeConfigBuildError(error, formatMessage)
          : formatMessage({ id: "agent.detail.runtimeConfigInvalid" }),
      );
      return;
    }
    const nextConfig = {
      runtime: draftRuntime,
      model: draftModel,
      runtimeConfig: nextRuntimeConfig,
      reasoningEffort: draftRuntime === "kimi-sdk"
        ? draftSchemaBacked ? null : undefined
        : draftSupportsReasoning ? draftReasoningEffort as ReasoningEffort | null : null,
      ...(draftSchemaBacked && draftFormDefinitionRef
        ? { formDefinitionRef: draftFormDefinitionRef }
        : {}),
    };

    if (runtimeChanged) {
      const fromRuntimeLabel = getRuntimeDisplayName(currentRuntime);
      const nextRuntimeLabel = getRuntimeDisplayName(draftRuntime);
      const nextModelLabel = getModelLabel(draftRuntime, draftModel);
      requestConfirm({
        title: formatMessage({ id: "agent.detail.switchRuntimeConfig" }),
        message: isActive
          ? formatMessage(
              { id: "agent.detail.switchRuntimeActiveMessage" },
              { from: fromRuntimeLabel, to: nextRuntimeLabel, model: nextModelLabel, reasoning: draftSupportsReasoning ? nextReasoningLabel : "", mode: nextModeLabel },
            )
          : formatMessage(
              { id: "agent.detail.switchRuntimeInactiveMessage" },
              { from: fromRuntimeLabel, to: nextRuntimeLabel, model: nextModelLabel, reasoning: draftSupportsReasoning ? nextReasoningLabel : "", mode: nextModeLabel },
            ),
        confirmLabel: isActive
          ? formatMessage({ id: "agent.detail.resetRuntimeSession" })
          : formatMessage({ id: "agent.detail.saveRuntimeChange" }),
        loadingLabel: isActive
          ? formatMessage({ id: "agent.detail.resetting" })
          : formatMessage({ id: "agent.detail.applying" }),
        confirmColor: "bg-brutal-orange",
        onConfirm: async () => {
          await saveRuntimeConfiguration(nextConfig, "session");
        },
      });
      return;
    }

    if (!isActive) {
      setSavingRuntimeConfig(true);
      try {
        await saveRuntimeConfiguration(nextConfig);
        closeRuntimeConfigEditor();
      } finally {
        setSavingRuntimeConfig(false);
      }
      return;
    }

    // tygg/Tenny 2026-07-10: a Codex model switch resets the native runtime
    // session (Codex `thread/resume` pins the resumed thread's model, so a plain
    // restart keeps the old model — root of the 5.5→5.6 switch-not-applying
    // report). Warn about the session/context reset and save as "session". A
    // reasoning-effort-only change falls through to the restart branch below
    // (context preserved). Codex-scoped; model+effort together reset once here.
    if (draftRuntime === "codex" && (modelChanged || customModelModeChanged)) {
      requestConfirm({
        title: formatMessage({ id: "agent.detail.switchModelResetSession" }),
        message: formatMessage(
          { id: "agent.detail.switchModelResetMessage" },
          // "none" (not "") is the ICU select sentinel: an empty string does not
          // match a select key, so `reasoning: ""` renders the empty parenthetical
          // "( reasoning)". Same pattern as migration.error.bundleTooLarge.
          { model: getModelLabel(draftRuntime, draftModel), reasoning: draftSupportsReasoning ? nextReasoningLabel : "none" },
        ),
        confirmLabel: formatMessage({ id: "agent.detail.reset" }),
        loadingLabel: formatMessage({ id: "agent.detail.resetting" }),
        confirmColor: "bg-brutal-orange",
        onConfirm: async () => {
          await saveRuntimeConfiguration(nextConfig, "session");
        },
      });
      return;
    }

    const changeLabels: string[] = [];
    if (modelChanged || customModelModeChanged) changeLabels.push(formatMessage({ id: "agent.runtimeConfig.model" }));
    if (providerChanged) changeLabels.push(formatMessage({ id: "agent.runtimeConfig.provider" }));
    if (fastModeChanged) changeLabels.push(formatMessage({ id: "agent.runtimeConfig.mode" }));
    if (commandChanged) changeLabels.push(formatMessage({ id: "agent.runtimeConfig.command" }));
    if (reasoningChanged) changeLabels.push(formatMessage({ id: "agent.runtimeConfig.reasoning" }));
    if (envVarsChanged) changeLabels.push(formatMessage({ id: "agent.runtimeConfig.envVars" }));
    const changeSummary = formatList(changeLabels, { type: "conjunction" });
    requestConfirm({
      title: formatMessage({ id: "agent.detail.restartToApplyRuntimeConfig" }),
      message: formatMessage(
        { id: "agent.detail.restartToApplyRuntimeConfigMessage" },
        { changes: changeSummary, model: getModelLabel(draftRuntime, draftModel), reasoning: draftSupportsReasoning ? nextReasoningLabel : "", mode: nextModeLabel },
      ),
      confirmLabel: formatMessage({ id: "agent.detail.restartAgent" }),
      loadingLabel: formatMessage({ id: "machine.detail.restarting" }),
      confirmColor: "bg-brutal-cyan",
      onConfirm: async () => {
        await saveRuntimeConfiguration(nextConfig, "restart");
      },
    });
  };

  return (
    <>
      {/* Display Name */}
      <div className="px-5 pt-4 pb-3">
        <div className="flex items-center gap-2 mb-1">
          <SectionEyebrow as="div">
            {formatMessage({ id: "agent.detail.displayName" })}
          </SectionEyebrow>
          {canManageAgent && !editingDisplayName && (
            <button
              type="button"
              onClick={() => {
                setDisplayNameValue(agent.displayName || "");
                setDisplayNameError("");
                setEditingDisplayName(true);
              }}
              className="text-black/40 hover:text-black transition-colors"
              title={formatMessage({ id: "agent.detail.editDisplayName" })}
            >
              <Pencil size={12} />
            </button>
          )}
        </div>
        {canManageAgent && editingDisplayName ? (
          <div className="space-y-[5px]">
            <input
              ref={displayNameRef}
              value={displayNameValue}
              onChange={(e) => {
                setDisplayNameValue(e.target.value.replace(/[\r\n]+/g, " "));
                if (displayNameError) setDisplayNameError("");
              }}
              placeholder={formatMessage({ id: "agent.detail.displayName" })}
              className="h-8 w-full border-2 border-black px-2 py-1 text-sm shadow-brutal-sm focus:outline-none focus:shadow-brutal-sm"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void handleSaveDisplayName();
                }
                if (e.key === "Escape") {
                  setDisplayNameError("");
                  setEditingDisplayName(false);
                }
              }}
            />
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => void handleSaveDisplayName()}
                disabled={savingDisplayName}
                className="btn-brutal-sm bg-brutal-pink px-2 py-1 text-xs disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {formatMessage({ id: "machine.detail.save" })}
              </button>
              <button
                onClick={() => {
                  setDisplayNameError("");
                  setEditingDisplayName(false);
                }}
                disabled={savingDisplayName}
                className="btn-brutal-sm bg-white px-2 py-1 text-xs disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {formatMessage({ id: "common.confirm.cancel" })}
              </button>
            </div>
            {displayNameError && (
              <div className="text-xs font-bold text-brutal-orange">
                {displayNameError}
              </div>
            )}
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm text-black">
              {agent.displayName || agent.name}
            </p>
            {currentOnboardingIdentityPreview?.canAdopt && (
              <button
                type="button"
                onClick={handleAdoptOnboardingIdentity}
                className="btn-brutal-sm bg-brutal-pink px-2 py-1 text-xs"
              >
                {formatMessage({ id: "agent.detail.updateOfficialIdentity" })}
              </button>
            )}
          </div>
        )}
        {currentOnboardingIdentityError && (
          <div className="mt-2 text-xs font-bold text-brutal-orange">{currentOnboardingIdentityError}</div>
        )}
      </div>

      {/* Description */}
      <div className="px-5 py-3">
        <div className="flex items-center gap-2 mb-1">
          <SectionEyebrow as="div">
            {formatMessage({ id: "machine.detail.description" })}
          </SectionEyebrow>
          {canManageAgent && !editingRole && (
            <button
              type="button"
              onClick={() => {
                setRoleValue(agent.description || "");
                setRoleError("");
                setEditingRole(true);
              }}
              className="text-black/40 hover:text-black transition-colors"
              title={formatMessage({ id: "agent.detail.editDescription" })}
            >
              <Pencil size={12} />
            </button>
          )}
        </div>
        {canManageAgent && editingRole ? (
          <div className="space-y-[5px]">
            <textarea
              ref={roleRef}
              value={roleValue}
              onChange={(e) => {
                setRoleValue(e.target.value);
                if (roleError) setRoleError("");
              }}
              placeholder={formatMessage({ id: "agent.detail.describeAgentPlaceholder" })}
              className="m-0 min-h-10 w-full border-2 border-black px-2 py-1 text-sm leading-4 shadow-brutal-sm focus:outline-none focus:shadow-brutal-sm resize-none overflow-hidden"
              rows={2}
              autoFocus
              maxLength={MAX_AGENT_DESCRIPTION_LENGTH}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setRoleError("");
                  setEditingRole(false);
                }
              }}
            />
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => void handleSaveRole()}
                disabled={savingRole}
                className="btn-brutal-sm bg-brutal-pink px-2 py-1 text-xs disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {formatMessage({ id: "machine.detail.save" })}
              </button>
              <button
                onClick={() => {
                  setRoleError("");
                  setEditingRole(false);
                }}
                disabled={savingRole}
                className="btn-brutal-sm bg-white px-2 py-1 text-xs disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {formatMessage({ id: "common.confirm.cancel" })}
              </button>
            </div>
            <div className="flex items-center justify-between gap-3 text-xs">
              {roleError ? (
                <span className="font-bold text-brutal-orange">
                  {roleError}
                </span>
              ) : (
                <span />
              )}
              <span className="font-mono text-black/50">
                {roleValue.trim().length}/{MAX_AGENT_DESCRIPTION_LENGTH}
              </span>
            </div>
          </div>
        ) : (
          <p className="text-sm text-black">
            {agent.description || (
              <span className="italic text-black/40">{formatMessage({ id: "machine.detail.noDescription" })}</span>
            )}
          </p>
        )}
      </div>

      {showOperationalInfo && isExternalAgent && canManageAgent && (
        <div className="border-t border-black/10 px-5 py-4">
          <SectionEyebrow as="div" className="mb-2">
            {formatMessage({ id: "agent.detail.externalSetup" })}
          </SectionEyebrow>
          <div className="space-y-3 border-2 border-black bg-brutal-cyan/15 p-3 shadow-brutal-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex border-2 border-black bg-white px-2 py-0.5 text-xs font-bold uppercase text-black">
                {externalStatus?.setupState === "connected"
                  ? formatMessage({ id: "machine.detail.connected" })
                  : externalStatus?.setupState === "credential_minted"
                    ? formatMessage({ id: "agent.detail.credentialMinted" })
                    : formatMessage({ id: "agent.detail.waitingForLogin" })}
              </span>
              {externalStatus?.credentialLastUsedAt && (
                <span className="text-xs font-mono text-black/50">
                  {formatMessage(
                    { id: "agent.detail.lastUsed" },
                    { time: formatShortDateTime(externalStatus.credentialLastUsedAt) },
                  )}
                </span>
              )}
            </div>
            {(capabilities.issueAgentCredentials || (agent.creatorType === "user" && agent.creatorId === currentUserId)) && (
              <ExternalAgentToken key={agent.id} agentId={agent.id} />
            )}
            <ExternalSetupTabSegmentedControl
              value={effectiveExternalSetupTab}
              onValueChange={(value) => {
                setExternalSetupTab(value);
                setExternalCopiedTarget(null);
              }}
            />
            {externalStepSetupSteps ? (
              <div className="space-y-3">
                <p className="text-xs font-bold text-black/70">
                    {formatMessage({ id: "agent.detail.runStepsInTerminal" })}
                </p>
                <ol className="space-y-4">
                  {externalStepSetupSteps.map((step, idx) => {
                    const copyTarget = `${effectiveExternalSetupTab}-step-${idx + 1}`;
                    return (
                      <li key={step.title} className="space-y-1.5">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="text-xs font-bold uppercase text-black/60">
                            {formatMessage({ id: "agent.detail.stepNumber" }, { step: idx + 1 })}
                          </span>
                          <button
                            type="button"
                            onClick={() => void handleCopyExternalCommand(step.command, copyTarget)}
                            className="btn-brutal-sm bg-white px-2 py-1 text-xs"
                          >
                            {externalCopiedTarget === copyTarget
                              ? formatMessage({ id: "agent.detail.copied" })
                              : formatMessage({ id: "agent.detail.copyStep" })}
                          </button>
                        </div>
                        <p className="text-sm font-bold text-black">{step.title}</p>
                        <div className="break-all border border-black/20 bg-white/80 p-2 font-mono text-xs text-black whitespace-pre-wrap">
                          {step.command}
                        </div>
                        {step.description && (
                          <p className="text-xs text-black/60">{step.description}</p>
                        )}
                      </li>
                    );
                  })}
                </ol>
                <p className="text-xs text-black/60">
                    {formatMessage({ id: "agent.detail.raftProfileRequired" })}
                </p>
                {effectiveExternalSetupTab === "claude-code" ? (
                  <p className="text-xs text-black/60">
                    {formatMessage({ id: "agent.detail.claudeCodeKeepRunning" })}
                  </p>
                ) : effectiveExternalSetupTab === "hermes" ? (
                  <p className="text-xs text-black/60">
                    {formatMessage({ id: "agent.detail.hermesGatewayDescription" })}
                  </p>
                ) : null}
              </div>
            ) : (
              <div className="space-y-2">
                <div className="break-all border-2 border-black bg-white p-2 font-mono text-xs text-black whitespace-pre-wrap">
                  {externalOtherSetupInstruction}
                </div>
                <p className="text-xs text-black/60">
                      {formatMessage({ id: "agent.detail.otherAgentRuntimeDescription" })}
                </p>
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2">
              {effectiveExternalSetupTab === "other-agents" && (
                <button
                  type="button"
                  onClick={() => void handleCopyExternalCommand()}
                  className="btn-brutal-sm bg-white px-2 py-1 text-xs"
                >
                  {externalCopiedTarget === "setup"
                    ? formatMessage({ id: "agent.detail.copied" })
                    : formatMessage({ id: "agent.detail.copySetup" })}
                </button>
              )}
              {externalStatusError && (
                <span className="text-xs font-bold text-brutal-orange">{externalStatusError}</span>
              )}
            </div>
          </div>
        </div>
      )}

      {showOperationalInfo && (
        <>
          {/* Info */}
          <div className="px-5 py-4 border-t border-black/10">
            <SectionEyebrow as="div" className="mb-3">
              {formatMessage({ id: "machine.detail.info" })}
            </SectionEyebrow>
            <div className="space-y-3">
              {/* Role */}
              <div>
                <div className="mb-1 flex items-center gap-2">
                  <div className="text-xs text-black/50">{formatMessage({ id: "agent.detail.role" })}</div>
                  <button
                    type="button"
                    onClick={() => setShowRoleHelp(true)}
                    className="text-black/35 transition-colors hover:text-black"
                    title={formatMessage({ id: "agent.detail.rolePermissions" })}
                  >
                    <HelpCircle size={12} />
                  </button>
                  {canEditServerRole && currentAgentServerRole && !editingServerRole && (
                    <button
                      type="button"
                      onClick={() => {
                        setServerRoleValue(currentAgentServerRole);
                        setServerRolePickerOpen(true);
                        setServerRoleError("");
                        setEditingServerRole(true);
                      }}
                      className="text-black/40 transition-colors hover:text-black"
                      title={formatMessage({ id: "agent.detail.editRole" })}
                    >
                      <Pencil size={12} />
                    </button>
                  )}
                </div>
                {canEditServerRole && currentAgentServerRole && currentAgentServerRoleInfo ? (
                  <div className="space-y-1.5">
                    {editingServerRole ? (
                      <>
                        <InlineBadgeEditor
                          displayValue={formatMessage({ id: AGENT_ROLE_CONFIG[serverRoleValue].labelId })}
                          selectedId={serverRoleValue}
                          options={editableAgentRoleOptions}
                          onSelect={(nextRole) => {
                            setServerRoleValue(nextRole as Extract<ServerRole, "admin" | "member">);
                            setServerRolePickerOpen(false);
                          }}
                          open={serverRolePickerOpen}
                          onToggle={() => setServerRolePickerOpen((value) => !value)}
                          onRequestClose={() => setServerRolePickerOpen(false)}
                          badgeClassName={AGENT_ROLE_CONFIG[serverRoleValue].color}
                          uppercase={false}
                          dropdownMinWidth="min-w-[140px]"
                          dropdownAlign="left"
                        />
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => void handleSaveServerRole()}
                            disabled={serverRoleSaving || serverRoleValue === currentAgentServerRole}
                            className="btn-brutal-sm bg-brutal-pink px-2 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            {formatMessage({ id: "machine.detail.save" })}
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setServerRoleValue(currentAgentServerRole);
                              setServerRolePickerOpen(false);
                              setServerRoleError("");
                              setEditingServerRole(false);
                            }}
                            disabled={serverRoleSaving}
                            className="btn-brutal-sm bg-white px-2 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            {formatMessage({ id: "common.confirm.cancel" })}
                          </button>
                        </div>
                        {serverRoleError && (
                          <div className="text-xs font-bold text-brutal-orange">{serverRoleError}</div>
                        )}
                      </>
                    ) : (
                      <span className={`inline-block border-2 border-black px-2 py-0.5 text-xs font-bold text-black ${currentAgentServerRoleInfo.color}`}>
                        {formatMessage({ id: currentAgentServerRoleInfo.labelId })}
                      </span>
                    )}
                  </div>
                ) : currentAgentServerRoleInfo ? (
                  <span className={`inline-block border-2 border-black px-2 py-0.5 text-xs font-bold text-black ${currentAgentServerRoleInfo.color}`}>
                    {formatMessage({ id: currentAgentServerRoleInfo.labelId })}
                  </span>
                ) : serverRoleDisplay.kind === "unrecognized" ? (
                  <span
                    className="inline-block border-2 border-black bg-gray-100 px-2 py-0.5 text-xs font-bold text-black"
                    title={agent.serverRole ?? undefined}
                  >
                    {serverRoleDisplay.label}
                  </span>
                ) : null}
              </div>
              {/* Computer */}
              <div>
                <div className="text-xs text-black/50 mb-1">{formatMessage({ id: "machine.detail.computer" })}</div>
                <div className="min-w-0 space-y-1.5 text-sm">
                  {isExternalAgent ? (
                    <span className="text-xs text-black/40 italic">{formatMessage({ id: "agent.detail.externalRuntime" })}</span>
                  ) : agentMachineRow.kind === "pending" ? null : agentMachine ? (
                    <>
                      <button
                        onClick={() => { useProfileStore.getState().closeProfile(); useThreadStore.getState().closeThread(); nav.toMachine(agentMachine.id); }}
                        className="block max-w-full break-all text-left font-mono font-semibold text-black hover:underline"
                      >
                        {agentMachine.name}
                      </button>
                      <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-black/50">
                        <StatusDot
                          tone={machineStatus === "online" ? "bg-brutal-lime" : "bg-gray-400"}
                          className="shrink-0"
                        />
                        <span>
                          {machineStatus === "online"
                            ? formatMessage({ id: "machine.detail.connected" })
                            : formatMessage({ id: "machine.detail.offline" })}
                        </span>
                        {agentMachine && (
                          <span className="font-mono">· <MachineRunLabel machine={agentMachine} /></span>
                        )}
                      </div>
                    </>
                  ) : (
                    <span className="text-xs text-black/40 italic">
                      {formatMessage({ id: "agent.detail.noComputerAssigned" })}
                    </span>
                  )}
                </div>
              </div>
              <div className="flex flex-wrap gap-x-8 gap-y-3">
                {/* Created */}
                <KeyValueRow label={formatMessage({ id: "machine.detail.created" })} value={createdDate} mono />
                {/* Creator */}
                <KeyValueRow
                  label={formatMessage({ id: "agent.detail.creator" })}
                  valueClassName="flex items-center gap-2"
                  value={
                    agent.creator ? (
                      <button
                        type="button"
                        onClick={() => {
                          const type = agent.creator!.type === "human" ? "human" : "agent";
                          (onOpenProfile ?? openProfile)(type, agent.creator!.id);
                        }}
                        className="flex items-center gap-2 text-sm text-black hover:underline"
                      >
                        {agent.creator.type === "human" ? (
                          <AvatarSlot
                            context="creator-link"
                            type="human"
                            humanAvatarUrl={agent.creator.avatarUrl}
                            gravatarHash={agent.creator.gravatarHash}
                          />
                        ) : (
                          <AvatarSlot
                            context="creator-link"
                            type="agent"
                            agentAvatarUrl={agent.creator.avatarUrl}
                          />
                        )}
                        <span className="font-bold">{agent.creator.displayName || agent.creator.name}</span>
                        <span className="font-mono text-xs text-black/50">@{agent.creator.name}</span>
                      </button>
                    ) : (
                      <span className="text-sm italic text-black/40">
                        {formatMessage({ id: "agent.detail.noCreatorAssigned" })}
                      </span>
                    )
                  }
                />
              </div>
            </div>
          </div>

          {!isExternalAgent && (
            <div ref={configRef} className="px-5 py-4 border-t border-black/10">
              <div className="w-full">
                <div className="flex items-center gap-2 mb-1">
                  <SectionEyebrow as="div">
                    {formatMessage({ id: "agent.detail.runtimeConfig" })}
                  </SectionEyebrow>
                  {canManageAgent && !editingRuntimeConfig && (
                    <button
                      type="button"
                      onClick={startRuntimeConfigEditing}
                      className="text-black/40 hover:text-black transition-colors"
                      title={formatMessage({ id: "agent.detail.editRuntimeConfig" })}
                    >
                      <Pencil size={12} />
                    </button>
                  )}
                </div>
                <div className="flex flex-wrap gap-4">
                  <KeyValueRow
                    label={formatMessage({ id: "agent.runtimeConfig.runtime" })}
                    value={
                      <RuntimeAccountUsageGateChip
                        enabled={canViewRuntimeAccountUsage}
                        runtimeId={currentRuntimeConfig.runtime}
                        runtimeVersion={agentMachine?.runtimeVersions?.[currentRuntimeConfig.runtime]}
                        serverId={currentServer?.id ?? null}
                        machineId={agentMachine?.id ?? ""}
                        className="h-6 border-2 border-black bg-brutal-cyan px-2 py-0.5 text-xs font-bold text-black"
                      >
                        {formatRuntimeLabelWithStatus(currentRuntimeConfig.runtime, formatMessage)}
                      </RuntimeAccountUsageGateChip>
                    }
                  />
                  {currentRuntimeDeprecated && (
                    <div className="basis-full">
                      <Banner intent="warning" density="sm" className="font-bold">
                        {formatMessage({ id: "agent.detail.deprecatedRuntimeWarning" })}
                      </Banner>
                    </div>
                  )}
                  <KeyValueRow
                    label={formatMessage({ id: "agent.runtimeConfig.model" })}
                    value={
                      <span className="inline-block border-2 border-black bg-brutal-lavender px-2 py-0.5 text-xs font-bold text-black">
                        {currentRuntimeModelLabel}
                      </span>
                    }
                  />
                  {REASONING_EFFORT_RUNTIMES.has(currentRuntimeConfig.runtime) && (
                    <KeyValueRow
                      label={formatMessage({ id: "agent.runtimeConfig.reasoning" })}
                      value={
                        <span className="inline-block border-2 border-black bg-soft-signal px-2 py-0.5 text-xs font-bold capitalize text-black">
                          {currentRuntimeConfig.reasoningEffort
                            ? formatMessage({ id: reasoningEffortLabelId(currentRuntimeConfig.reasoningEffort) ?? "agent.runtimeConfig.default" })
                            : formatMessage({ id: "agent.runtimeConfig.default" })}
                        </span>
                      }
                    />
                  )}
                  {supportsRuntimeFastMode(currentRuntimeConfig.runtime) && (
                    <KeyValueRow
                      label={formatMessage({ id: "agent.runtimeConfig.mode" })}
                      value={
                        <span className="inline-block border-2 border-black bg-brutal-orange px-2 py-0.5 text-xs font-bold text-black">
                          {runtimeConfigFastMode(currentRuntimeConfig)
                            ? formatMessage({ id: "agent.runtimeConfig.fastMode" })
                            : formatMessage({ id: "agent.runtimeConfig.default" })}
                        </span>
                      }
                    />
                  )}
                  {currentRuntimeConfig.runtime === "claude" && (
                    <>
                      <KeyValueRow
                        label={formatMessage({ id: "agent.runtimeConfig.provider" })}
                        value={
                          currentProviderApiUrl
                            ? <span className="font-mono text-xs text-black">{currentProviderApiUrl}</span>
                            : <span className="text-xs italic text-black/40">{formatMessage({ id: "agent.runtimeConfig.default" })}</span>
                        }
                      />
                      <KeyValueRow
                        label={formatMessage({ id: "agent.runtimeConfig.command" })}
                        value={
                          currentCommand
                            ? <span className="font-mono text-xs text-black">{currentCommand}</span>
                            : <span className="text-xs italic text-black/40">{formatMessage({ id: "agent.runtimeConfig.default" })}</span>
                        }
                      />
                    </>
                  )}
                </div>
                <div className="mt-3">
                  <EnvVarsSection agent={agent} canManageAgent={false} />
                </div>
              </div>
            </div>
          )}

          <AgentCreatedAgentsSection
            createdAgents={agent.createdAgents || []}
            onOpenProfile={onOpenProfile}
          />
        </>
      )}

      {pendingConfirm && (
        <ConfirmDialog
          title={pendingConfirm.title}
          message={pendingConfirm.message}
          confirmLabel={pendingConfirm.confirmLabel}
          loadingLabel={pendingConfirm.loadingLabel}
          confirmColor={pendingConfirm.confirmColor}
          plainMessage={pendingConfirm.plainMessage}
          maxWidthClass={pendingConfirm.maxWidthClass}
          chromeLocale="active"
          onConfirm={pendingConfirm.onConfirm}
          onClose={() => setPendingConfirm(null)}
          layer={1}
        />
      )}

      {showRoleHelp && (
        <RolePermissionHelpDialog
          subject="agent"
          onClose={() => setShowRoleHelp(false)}
        />
      )}

      {editingRuntimeConfig && (
        <Modal onClose={closeRuntimeConfigEditor} layer={1}>
          <div ref={runtimeConfigModalRef} className="w-full max-w-md card-brutal p-6">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-bold uppercase">{formatMessage({ id: "agent.detail.editRuntimeConfig" })}</h2>
              <button onClick={closeRuntimeConfigEditor} className="btn-brutal-sm bg-white p-1">
                <X size={20} />
              </button>
            </div>
            <form
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                void handleSaveRuntimeConfiguration();
              }}
            >
              {providerConnectionCatalog.featureEnabled
                && draftRuntime === "builtin"
                && (providerConnectionCatalog.connections.length > 0 || currentProviderConnectionId) && (
                <div>
                  <label className="mb-1 block text-sm font-bold">
                    {formatMessage({ id: "agent.create.providerConnection" })}
                  </label>
                  <Select
                    // Agent Details' OWN select, not one of RuntimeConfigFields'.
                    // Retiring the legacy arm deleted the stylesheet override this
                    // used to inherit, so without `chrome="field"` it would fall
                    // back to raft-ui's BUTTON metrics and sit visibly different
                    // from the runtime-config fields directly beneath it.
                    chrome="field"
                    value={draftProviderConnectionId || "__inline_provider_connection__"}
                    items={[
                      { value: "__inline_provider_connection__", label: formatMessage({ id: "agent.create.providerConnectionInline" }) },
                      ...providerConnectionCatalog.connections.map((connection) => ({
                        value: connection.id,
                        label: connection.name,
                        disabled: !connection.enabled || connection.status !== "ready",
                      })),
                    ]}
                    onValueChange={(value) => {
                      if (value == null) return;
                      const nextId = value === "__inline_provider_connection__" ? "" : value;
                      setDraftProviderConnectionId(nextId);
                      const connection = providerConnectionCatalog.connections.find((candidate) => candidate.id === nextId);
                      if (!connection) return;
                      setDraftBuiltInProviderMode(connection.providerId);
                      setDraftBuiltInProviderApiKey("");
                      setDraftBuiltInProviderBaseUrl("");
                      if (isBuiltInGatewayProviderMode(connection.providerId)) {
                        setDraftModel("");
                        setDraftCustomModelMode(true);
                      } else {
                        setDraftModel(builtInProviderDefaultModel(connection.providerId) ?? "");
                        setDraftCustomModelMode(false);
                      }
                    }}
                  >
                    <SelectTrigger className="w-full" data-testid="edit-agent-provider-connection">
                      <SelectValue />
                      <SelectIcon />
                    </SelectTrigger>
                    <SelectContent portalProps={{ container: runtimeConfigModalRef }}>
                      <SelectList>
                        <SelectItem value="__inline_provider_connection__">
                          <SelectItemText>{formatMessage({ id: "agent.create.providerConnectionInline" })}</SelectItemText>
                          <SelectItemIndicator />
                        </SelectItem>
                        {providerConnectionCatalog.connections.map((connection) => (
                          <SelectItem
                            key={connection.id}
                            value={connection.id}
                            disabled={!connection.enabled || connection.status !== "ready"}
                          >
                            <SelectItemText>{connection.name}</SelectItemText>
                            <SelectItemIndicator />
                          </SelectItem>
                        ))}
                      </SelectList>
                    </SelectContent>
                  </Select>
                  {providerConnectionInvalid && (
                    <p className="mt-1 text-xs font-bold text-brutal-red">
                      {formatMessage({ id: "agent.create.providerConnectionUnavailable" })}
                    </p>
                  )}
                </div>
              )}
              <RuntimeConfigFields
                runtime={draftRuntime}
                onRuntimeChange={(id) => {
                  setDraftRuntime(id);
                  const nextModel = getDefaultModel(id);
                  setDraftModel(nextModel);
                  setDraftCustomModelMode(false);
                  setDraftProviderMode("default");
                  setDraftProviderApiUrl("");
                  setDraftProviderApiKey("");
                  setDraftBuiltInProviderMode(BUILTIN_RUNTIME_DEFAULT_PROVIDER_ID);
                  setDraftBuiltInProviderApiKey("");
                  setDraftBuiltInProviderBaseUrl("");
                  setDraftBuiltInProviderSupportsImageInput(false);
                  setDraftProviderConnectionId("");
                  setDraftPiProviderMode(PI_PROVIDER_CONFIGURED);
                  setDraftPiProviderApiKey("");
                  setDraftFastMode(false);
                  setDraftCommand("");
                  if (!REASONING_EFFORT_RUNTIMES.has(id)) {
                    setDraftReasoningEffort(null);
                  } else {
                    setDraftReasoningEffort(reconcileReasoningEffort(id, nextModel, null));
                  }
                }}
                runtimeOptions={runtimeOptions}
                model={draftModel}
                persistedModel={
                  draftRetainsBuiltInPresetSelection
                    ? currentRuntimeModel
                    : undefined
                }
                onModelChange={changeDraftModel}
                customModelMode={draftCustomModelMode}
                onCustomModelModeChange={setDraftCustomModelMode}
                modelOptions={modelOptions}
                runtimeModels={runtimeModels}
                rescanDisabled={!agent.machineId}
                providerMode={draftProviderMode}
                onProviderModeChange={setDraftProviderMode}
                providerApiUrl={draftProviderApiUrl}
                onProviderApiUrlChange={setDraftProviderApiUrl}
                providerApiKey={draftProviderApiKey}
                onProviderApiKeyChange={setDraftProviderApiKey}
                builtInProviderMode={draftBuiltInProviderMode}
                onBuiltInProviderModeChange={(next) => {
                  setDraftBuiltInProviderMode(next);
                  setDraftBuiltInProviderSupportsImageInput(false);
                  if (isBuiltInGatewayProviderMode(next)) {
                    setDraftModel("");
                    setDraftCustomModelMode(true);
                    return;
                  }
                  setDraftBuiltInProviderBaseUrl("");
                  const defaultModel = builtInProviderDefaultModel(next);
                  if (defaultModel) {
                    setDraftModel(defaultModel);
                    setDraftCustomModelMode(false);
                  }
                }}
                builtInProviderApiKey={draftBuiltInProviderApiKey}
                onBuiltInProviderApiKeyChange={setDraftBuiltInProviderApiKey}
                builtInProviderBaseUrl={draftBuiltInProviderBaseUrl}
                onBuiltInProviderBaseUrlChange={setDraftBuiltInProviderBaseUrl}
                builtInProviderSupportsImageInput={draftBuiltInProviderSupportsImageInput}
                onBuiltInProviderSupportsImageInputChange={setDraftBuiltInProviderSupportsImageInput}
                piProviderMode={draftPiProviderMode}
                onPiProviderModeChange={(next) => {
                  setDraftPiProviderMode(next);
                  // Switching to a builtin provider locks the Model picker
                  // to that provider's SDK first-class set; reset draftModel
                  // to the provider's default so the picker shows a valid
                  // value.
                  if (next !== PI_PROVIDER_CONFIGURED) {
                    const defaultModel = piBuiltinProviderDefaultModel(next);
                    if (defaultModel) {
                      setDraftModel(defaultModel);
                      setDraftCustomModelMode(false);
                    }
                  }
                }}
                piProviderApiKey={draftPiProviderApiKey}
                onPiProviderApiKeyChange={setDraftPiProviderApiKey}
                fastMode={draftFastMode}
                onFastModeChange={setDraftFastMode}
                command={draftCommand}
                onCommandChange={setDraftCommand}
                reasoningEffort={draftReasoningEffort}
                onReasoningEffortChange={setDraftReasoningEffort}
                envVarEntries={draftEnvVarEntries}
                onEnvVarEntriesChange={setDraftEnvVarEntries}
                envVarsMode="advanced"
                advancedOpen={runtimeConfigAdvancedOpen}
                onAdvancedOpenChange={setRuntimeConfigAdvancedOpen}
                envVarsHint={formatMessage({ id: "agent.detail.envVarsInjectedHint" })}
                selectedModelSuggestionOnly={draftModelSuggestionOnly}
                selectPortalContainer={runtimeConfigModalRef}
                managedConnectionActive={managedConnectionActive}
                schemaBacked={draftSchemaBacked}
                formDefinition={draftFormDefinition}
                formDefinitionLoading={draftSchemaBacked && runtimeFormDefinitionCatalog.loading}
                formDefinitionError={draftSchemaBacked && !runtimeFormDefinitionCatalog.loading && Boolean(draftFormDefinitionEntry?.error)}
              />

              {runtimeConfigSaveError ? (
                <Banner intent="warning" density="sm" className="font-bold">
                  {runtimeConfigSaveError}
                </Banner>
              ) : null}

              {legacyKimiReasoningRequiresUpgrade ? (
                <Banner intent="warning" density="sm" className="font-bold" data-testid="kimi-reasoning-upgrade-required">
                  {formatMessage({ id: "agent.runtimeConfig.kimiReasoningUpgradeRequired" })}
                </Banner>
              ) : null}

              <div className="flex justify-end gap-3">
                <button
                  type="button"
                  onClick={closeRuntimeConfigEditor}
                  disabled={savingRuntimeConfig}
                  className="btn-brutal bg-white px-4 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {formatMessage({ id: "common.confirm.cancel" })}
                </button>
                <button
                  type="submit"
                  disabled={runtimeConfigSaveDisabled}
                  className="btn-brutal bg-brutal-pink px-4 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {formatMessage({ id: "agent.detail.saveRuntimeConfig" })}
                </button>
              </div>
            </form>
          </div>
        </Modal>
      )}
    </>
  );
}

function AgentCreatedAgentsSection({ createdAgents, onOpenProfile }: { createdAgents: Agent["createdAgents"]; onOpenProfile?: (type: "agent" | "human", id: string) => void }) {
  const { formatMessage } = useIntl();
  const openProfile = useProfileStore((s) => s.openProfile);
  return (
    <div className="px-5 py-4 border-t border-black/10">
      <SectionHeader
        className="mb-3"
        label={formatMessage({ id: "agent.detail.createdAgents" })}
        count={createdAgents.length}
      />
      {createdAgents.length > 0 ? (
        <div className="space-y-2">
          {createdAgents.map((createdAgent) => (
            <AvatarListRow
              key={createdAgent.id}
              avatar={<AvatarSlot context="surface-list" type="agent" agentAvatarUrl={createdAgent.avatarUrl} />}
              name={createdAgent.displayName || createdAgent.name}
              subtitle={formatRuntimeLabelWithStatus(createdAgent.runtime, formatMessage)}
              rightContent={<CreatedAgentStatusDot agentId={createdAgent.id} />}
              onClick={() => (onOpenProfile ?? openProfile)("agent", createdAgent.id)}
            />
          ))}
        </div>
      ) : (
        <span className="text-sm italic text-black/40">{formatMessage({ id: "agent.detail.noCreatedAgents" })}</span>
      )}
    </div>
  );
}

function CreatedAgentStatusDot({ agentId }: { agentId: string }) {
  const { formatMessage } = useIntl();
  const displayState = useAgentDisplayState(agentId);
  const activityText = formatActivityText(
    formatMessage,
    displayState.activity,
    displayState.activityDetail,
    displayState.activityDetailKind,
  );
  return <StatusDot activity={displayState.activity} title={activityText} />;
}

// Isolated start/stop button — subscribes to activity for this agent only.
function AgentStartStopButton({ agentId, onShowStopConfirm }: { agentId: string; onShowStopConfirm: () => void }) {
  const { formatMessage } = useIntl();
  const displayState = useAgentDisplayState(agentId);
  const startAgent = useAgentStore((s) => s.startAgent);
  const isOnline = displayState.isOnline;
  return (
    <button
      onClick={isOnline ? onShowStopConfirm : () => startAgent(agentId)}
      className="btn-brutal flex w-full items-center justify-center gap-2 bg-white px-4 py-2 text-sm font-bold"
    >
      {isOnline ? <Square size={14} /> : <Play size={14} />}
      {isOnline
        ? formatMessage({ id: "agent.detail.stopAgent" })
        : formatMessage({ id: "agent.detail.startAgent" })}
    </button>
  );
}

// Isolated status badge — subscribes to activity for this agent only.
function AgentStatusBadge({ agentId, showDetail, fallbackStatus, externalStatus }: { agentId: string; showDetail: boolean; fallbackStatus?: Agent["status"]; externalStatus?: ExternalAgentStatus | null }) {
  const { formatMessage } = useIntl();
  const displayState = useAgentDisplayState(agentId, fallbackStatus ? { status: fallbackStatus } : undefined);
  const { formatShortDateTime } = useTimeFormatter();

  // External agents use SHA-V0-014 observed-activity copy, not managed liveness
  if (externalStatus) {
    const setupState = externalStatus.setupState;

    const ACTIVE_THRESHOLD_MS = 5 * 60 * 1000;
    const RECENT_THRESHOLD_MS = 30 * 60 * 1000;
    const lastAt = externalStatus.lastActivityAt ? new Date(externalStatus.lastActivityAt).getTime() : null;
    const ageMs = lastAt ? Date.now() - lastAt : null;
    const activityTone = ageMs !== null && ageMs < ACTIVE_THRESHOLD_MS
      ? "bg-brutal-lime"
      : ageMs !== null && ageMs < RECENT_THRESHOLD_MS
        ? "bg-brutal-cyan"
        : setupState === "waiting_for_login"
          ? "bg-gray-400"
          : "bg-brutal-cyan";

    // showDetail=false: external agents show only "External" (withhold timestamp detail)
    if (!showDetail) {
      return (
        <div className="flex min-w-0 items-center gap-1.5">
          <StatusDot tone={activityTone} className="shrink-0" />
          <span className="min-w-0 truncate text-sm text-black/60 font-mono">
            {formatMessage({ id: "agent.detail.external" })}
          </span>
        </div>
      );
    }
    let externalText = formatMessage({ id: "agent.detail.externalNotConfigured" });
    if (setupState === "waiting_for_login") {
      externalText = formatMessage({ id: "agent.detail.externalSetupRequired" });
    } else if (lastAt && ageMs !== null && ageMs < ACTIVE_THRESHOLD_MS) {
      externalText = formatMessage({ id: "agent.detail.externalActive" });
    } else if (lastAt) {
      externalText = formatMessage(
        { id: "agent.detail.externalLastActivity" },
        { time: formatShortDateTime(externalStatus.lastActivityAt!) },
      );
    } else if (setupState === "credential_minted") {
      externalText = formatMessage({ id: "agent.detail.externalNoRaftActivity" });
    } else if (setupState === "connected") {
      externalText = formatMessage({ id: "agent.detail.externalNoRaftActivity" });
    }
    return (
      <div className="flex min-w-0 items-center gap-1.5">
        <StatusDot tone={activityTone} className="shrink-0" />
        <span className="min-w-0 truncate text-sm text-black/60 font-mono" title={externalText}>
          {externalText}
        </span>
      </div>
    );
  }

  const activityText = showDetail
    ? formatActivityText(
      formatMessage,
      displayState.activity,
      displayState.activityDetail,
      displayState.activityDetailKind,
    )
    : formatActivityText(formatMessage, displayState.activity, "");
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <StatusDot activity={displayState.activity} className="shrink-0" />
      <span className="min-w-0 truncate text-sm text-black/60 font-mono" title={activityText}>
        {activityText}
      </span>
    </div>
  );
}

interface MigrationStartResponse {
  migrationRef: string;
  state: string;
  sourceMachineId: string;
  targetMachineId: string;
  deadlines?: Record<string, string>;
}

const MIGRATION_PROGRESS_STEPS = [
  "agent.detail.migrationStepSecureConnection",
  "agent.detail.migrationStepPrepareFiles",
  "agent.detail.migrationStepTransfer",
  "agent.detail.migrationStepFinish",
] as const;

function normalizedMigrationState(state: string): string {
  return state.toLowerCase();
}

function isActiveMigrationState(state: string): boolean {
  return [
    "provisioning",
    "prep",
    "ready",
    "in_transit",
    "arriving",
    "starting",
    "cancel_requested_pre_flip",
    "cancel_requested_post_flip",
  ].includes(
    normalizedMigrationState(state),
  );
}

function isCompletedMigrationState(state: string): boolean {
  return ["completed", "arrived"].includes(normalizedMigrationState(state));
}

function isFailedMigrationState(state: string): boolean {
  return ["failed", "aborted"].includes(normalizedMigrationState(state));
}

function isCanceledMigrationState(state: string): boolean {
  return ["canceled_pre_flip", "canceled_post_flip"].includes(normalizedMigrationState(state));
}

function migrationProgressStep(notice: MigrationNotice): number {
  const state = normalizedMigrationState(notice.state);
  if (isCompletedMigrationState(state)) return MIGRATION_PROGRESS_STEPS.length;
  if (state === "arriving" || state === "starting" || notice.arrivedAt || notice.flippedAt) return 3;
  if (state === "ready" || state === "in_transit" || notice.readyAt) return 2;
  if (state === "prep" || notice.transportProvisionedAt) return 1;
  return 0;
}

function migrationStartErrorPresentation(
  err: unknown,
  formatMessage: IntlShape["formatMessage"],
  computers: {
    sourceComputerName?: string | null;
    targetComputerName?: string | null;
    sourceComputerId?: string | null;
    targetComputerId?: string | null;
  } = {},
): MigrationErrorPresentation {
  const e = err as {
    response?: { data?: { error?: string; code?: string; details?: unknown } };
    message?: string;
  } | null;
  return migrationErrorPresentation({
    code: e?.response?.data?.code,
    rawMessage: e?.response?.data?.error ?? e?.message,
    context: "start",
    computerCapabilityDetails: parseMigrationComputerCapabilityDetails(
      e?.response?.data?.details,
    ),
    resumableCapabilityDetail: parseMigrationResumableCapabilityDetail(
      e?.response?.data?.details,
    ),
    ...computers,
  }, formatMessage);
}

function migrationFailurePresentation(
  notice: MigrationNotice,
  machines: Machine[],
  formatMessage: IntlShape["formatMessage"],
  formatTimestamp: (value: string) => string,
): MigrationErrorPresentation {
  const sourceMachine = machines.find((machine) => machine.id === notice.sourceMachineId);
  const targetMachine = machines.find((machine) => machine.id === notice.targetMachineId);
  const source = migrationTargetLabel(formatMessage, machines, notice.sourceMachineId);
  const target = migrationTargetLabel(formatMessage, machines, notice.targetMachineId);
  if (normalizedMigrationState(notice.state) === "aborted") {
    const fallback = migrationErrorPresentation({
      context: "aborted",
      reason: notice.abortReason,
    }, formatMessage);
    const id = notice.abortReason === "prep-deadline"
      ? "agent.detail.migrationAbortedPrepDeadline"
      : notice.abortReason === "transfer-deadline"
        ? "agent.detail.migrationAbortedTransferDeadline"
        : notice.abortReason === "arrival-deadline"
          ? "agent.detail.migrationAbortedArrivalDeadline"
          : "agent.detail.migrationAbortedFallback";
    return {
      message: formatMessage({ id }, { source, target }),
      ...(fallback.technicalCode ? { technicalCode: fallback.technicalCode } : {}),
    };
  }
  return migrationErrorPresentation({
    code: notice.transportErrorCode ?? notice.failureReason,
    rawMessage: notice.transportErrorMessage,
    context: "failed",
    reason: notice.abortReason,
    sourceComputerName: source,
    targetComputerName: target,
    sourceComputerStatus: sourceMachine?.status,
    targetComputerStatus: targetMachine?.status,
    sourceComputerLastHeartbeat: sourceMachine?.lastHeartbeat,
    targetComputerLastHeartbeat: targetMachine?.lastHeartbeat,
    transportLostAt: notice.transportLostAt,
    formatTimestamp,
  }, formatMessage);
}

function MigrationErrorContent({ presentation }: { presentation: MigrationErrorPresentation }) {
  const { formatMessage } = useIntl();
  return (
    <div className="space-y-1.5">
      <div>{presentation.message}</div>
      {presentation.issues?.length ? (
        <ul className="list-disc space-y-1 pl-5">
          {presentation.issues.map((issue, index) => <li key={`${index}:${issue}`}>{issue}</li>)}
        </ul>
      ) : null}
      {presentation.technicalCode || presentation.diagnosticRef ? (
        <details className="text-xs text-black/60">
          <summary className="font-bold">{formatMessage({ id: "agent.detail.technicalDetails" })}</summary>
          <div className="space-y-0.5">
            {presentation.technicalCode ? (
              <div>
                {formatMessage({ id: "agent.detail.technicalErrorCode" })}: {" "}
                <code>{presentation.technicalCode}</code>
              </div>
            ) : null}
            {presentation.diagnosticRef ? (
              <div>
                {formatMessage({ id: "agent.detail.diagnosticReference" })}: {" "}
                <code>{presentation.diagnosticRef}</code>
              </div>
            ) : null}
          </div>
        </details>
      ) : null}
    </div>
  );
}

function migrationTargetLabel(formatMessage: IntlShape["formatMessage"], machines: Machine[], targetMachineId: string | null | undefined): string {
  if (!targetMachineId) return formatMessage({ id: "agent.detail.unknownComputer" });
  return machines.find((machine) => machine.id === targetMachineId)?.name ?? targetMachineId.slice(0, 8);
}

function migrationSupportRef(notice: MigrationNotice): string {
  return notice.migrationRef;
}

function migrationStatusErrorPresentation(
  error: { code?: string; message?: string },
  formatMessage: IntlShape["formatMessage"],
): MigrationErrorPresentation {
  return migrationErrorPresentation({
    code: error.code,
    rawMessage: error.message,
    context: "status",
  }, formatMessage);
}

function MigrationReference({ notice }: { notice: MigrationNotice }) {
  const { formatMessage } = useIntl();
  const [copied, setCopied] = useState(false);
  const ref = migrationSupportRef(notice);
  const copy = async () => {
    try {
      await copyTextToClipboard(ref);
      setCopied(true);
      setClockTimeout(() => setCopied(false), 2_000);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-[11px] text-black/55">
      <span className="font-bold">{formatMessage({ id: "agent.migration.referenceLabel" })}</span>
      <code className="min-w-0 break-all font-mono">{ref}</code>
      <button
        type="button"
        onClick={() => void copy()}
        className="btn-brutal-sm flex size-6 shrink-0 items-center justify-center bg-white"
        title={copied
          ? formatMessage({ id: "agent.migration.referenceCopied" })
          : formatMessage({ id: "agent.migration.referenceCopy" })}
        aria-label={copied
          ? formatMessage({ id: "agent.migration.referenceCopied" })
          : formatMessage({ id: "agent.migration.referenceCopyAria" }, { ref })}
      >
        {copied ? <Check size={12} aria-hidden="true" /> : <Clipboard size={12} aria-hidden="true" />}
      </button>
    </div>
  );
}

function canCancelMigration(notice: MigrationNotice): boolean {
  return ["provisioning", "prep", "ready", "in_transit", "arriving", "starting"].includes(
    normalizedMigrationState(notice.state),
  ) && Number.isInteger(notice.revision) && (notice.revision ?? 0) > 0;
}

function migrationNoticePresentation(
  formatMessage: IntlShape["formatMessage"],
  notice: MigrationNotice,
  machines: Machine[],
  formatTimestamp: (value: string) => string,
) {
  const source = migrationTargetLabel(formatMessage, machines, notice.sourceMachineId);
  const target = migrationTargetLabel(formatMessage, machines, notice.targetMachineId);
  const normalizedState = notice.state.toLowerCase();
  if (normalizedState === "failed") {
    const failure = migrationFailurePresentation(notice, machines, formatMessage, formatTimestamp);
    return {
      intent: "warning" as const,
      title: formatMessage({ id: "agent.detail.migrationFailed" }),
      ...failure,
    };
  }
  if (normalizedState === "aborted") {
    const failure = migrationFailurePresentation(notice, machines, formatMessage, formatTimestamp);
    return {
      intent: "warning" as const,
      title: formatMessage({ id: "agent.detail.migrationAborted" }),
      ...failure,
    };
  }
  if (normalizedState === "cancel_requested_pre_flip") {
    return notice.cancelNeedsAttention
      ? {
          intent: "warning" as const,
          title: formatMessage({ id: "agent.migration.cancellationNeedsAttention" }),
          message: formatMessage({ id: "agent.migration.cancelPreAttentionMessage" }),
          technicalCode: notice.cancelErrorCode ?? undefined,
        }
      : {
          intent: "info" as const,
          title: formatMessage({ id: "agent.migration.cancelingTitle" }),
          message: formatMessage({ id: "agent.migration.cancelPreMessage" }),
        };
  }
  if (normalizedState === "cancel_requested_post_flip") {
    return notice.cancelNeedsAttention
      ? {
          intent: "warning" as const,
          title: formatMessage({ id: "agent.migration.cancellationNeedsAttention" }),
          message: formatMessage({ id: "agent.migration.cancelPostAttentionMessage" }),
          technicalCode: notice.cancelErrorCode ?? undefined,
        }
      : {
          intent: "info" as const,
          title: formatMessage({ id: "agent.migration.stoppingMigratedAgentTitle" }),
          message: formatMessage({ id: "agent.migration.cancelPostMessage" }),
        };
  }
  if (normalizedState === "canceled_pre_flip") {
    return {
      intent: "info" as const,
      title: formatMessage({ id: "agent.migration.canceledTitle" }),
      message: formatMessage({ id: "agent.migration.canceledPreMessage" }),
    };
  }
  if (normalizedState === "canceled_post_flip") {
    return {
      intent: "info" as const,
      title: formatMessage({ id: "agent.migration.canceledTitle" }),
      message: formatMessage({ id: "agent.migration.canceledPostMessage" }),
    };
  }
  if (normalizedState === "provisioning") {
    return {
      intent: "info" as const,
      title: formatMessage({ id: "agent.detail.migrationStatus" }),
      message: formatMessage({ id: "agent.detail.migrationProvisioning" }, { target }),
    };
  }
  if (normalizedState === "prep") {
    return {
      intent: "info" as const,
      title: formatMessage({ id: "agent.detail.migrationStatus" }),
      message: formatMessage({ id: "agent.detail.migrationPreparingSource" }, { source }),
    };
  }
  if (normalizedState === "ready") {
    return {
      intent: "info" as const,
      title: formatMessage({ id: "agent.detail.migrationStatus" }),
      message: formatMessage({ id: "agent.detail.migrationReady" }, { target }),
    };
  }
  if (normalizedState === "in_transit") {
    return {
      intent: "info" as const,
      title: formatMessage({ id: "agent.detail.migrationStatus" }),
      message: formatMessage({ id: "agent.detail.migrationTransferring" }, { target }),
    };
  }
  if (normalizedState === "arriving") {
    return {
      intent: "info" as const,
      title: formatMessage({ id: "agent.detail.migrationStatus" }),
      message: formatMessage({ id: "agent.detail.migrationArriving" }, { target }),
    };
  }
  if (normalizedState === "starting" && notice.failureReason === "auto_start_failed") {
    return {
      intent: "warning" as const,
      title: formatMessage({ id: "agent.detail.agentDidNotStart" }),
      message: formatMessage({ id: "agent.detail.agentDidNotStartMessage" }, { target }),
      technicalCode: "auto_start_failed",
    };
  }
  if (normalizedState === "starting") {
    return {
      intent: "info" as const,
      title: formatMessage({ id: "agent.detail.migrationStatus" }),
      message: formatMessage({ id: "agent.detail.migrationStarting" }, { target }),
    };
  }
  if (normalizedState === "completed" || normalizedState === "arrived") {
    return {
      intent: "success" as const,
      title: formatMessage({ id: "agent.detail.migrationStatus" }),
      message: formatMessage({ id: "agent.detail.migrationCompleted" }, { target }),
    };
  }
  return {
    intent: "info" as const,
    title: formatMessage({ id: "agent.detail.migrationStatus" }),
    message: formatMessage({ id: "agent.detail.migrationUnknownState" }, { state: notice.state, target }),
  };
}

function MigrationProgressPanel({
  notice,
  machines,
  onShowCancel,
}: {
  notice: MigrationNotice;
  machines: Machine[];
  onShowCancel: () => void;
}) {
  const { formatMessage } = useIntl();
  const { formatShortDateTime } = useTimeFormatter();
  const source = migrationTargetLabel(formatMessage, machines, notice.sourceMachineId);
  const target = migrationTargetLabel(formatMessage, machines, notice.targetMachineId);
  const presentation = migrationNoticePresentation(formatMessage, notice, machines, formatShortDateTime);
  const completed = isCompletedMigrationState(notice.state);
  const failed = isFailedMigrationState(notice.state)
    || (normalizedMigrationState(notice.state) === "starting" && notice.failureReason === "auto_start_failed");
  const canceled = isCanceledMigrationState(notice.state);
  const active = isActiveMigrationState(notice.state);
  const currentStep = migrationProgressStep(notice);
  const progress = completed ? 100 : Math.min(88, currentStep * 25 + 13);
  const cancelRequested = normalizedMigrationState(notice.state).startsWith("cancel_requested_");
  const statusLabel = completed
    ? formatMessage({ id: "agent.detail.migrationComplete" })
    : canceled
      ? formatMessage({ id: "agent.migration.canceledStatus" })
    : failed || notice.cancelNeedsAttention
      ? formatMessage({ id: "agent.detail.needsAttention" })
      : cancelRequested
        ? formatMessage({ id: "billing.canceling" })
        : formatMessage({ id: "agent.detail.inProgress" });
  const badgeVariant = completed
    ? "success"
    : canceled
      ? "muted"
    : failed || notice.cancelNeedsAttention
      ? "warning"
      : "information";
  const headerMessageId = completed
    ? "agent.detail.movedToTarget"
    : canceled
      ? "agent.detail.migrationToTargetCanceled"
      : failed || notice.cancelNeedsAttention
        ? "agent.detail.migrationToTargetNeedsAttention"
        : cancelRequested
          ? "agent.detail.cancelingMigrationToTarget"
          : active
            ? "agent.detail.movingToTarget"
            : "agent.detail.migrationToTarget";

  return (
    <section aria-label={formatMessage({ id: "agent.detail.migrationToTarget" }, { target })}>
      <SurfaceListItem interactive={false} className="space-y-3">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          {completed ? (
            <CircleCheck size={18} className="shrink-0 text-black" aria-hidden="true" />
          ) : canceled ? (
            <X size={18} className="shrink-0 text-black" aria-hidden="true" />
          ) : failed ? (
            <TriangleAlert size={18} className="shrink-0 text-black" aria-hidden="true" />
          ) : (
            <Spinner size="md" aria-hidden="true" />
          )}
          <div className="min-w-0">
            <h3 className="break-words text-sm font-bold leading-tight text-black">
              {formatMessage({ id: headerMessageId }, { target })}
            </h3>
            <p className="text-xs text-black/55">{formatMessage({ id: "agent.detail.workspaceAndAgentState" })}</p>
          </div>
        </div>
        <Badge appearance="outline" variant={badgeVariant} uppercase className="shrink-0">
          {statusLabel}
        </Badge>
      </div>

      <MigrationReference notice={notice} />

      <ProgressBar
        value={progress}
        tone={completed ? "lime" : failed || canceled ? "orange" : "pink"}
        label={formatMessage({ id: "agent.detail.migrationProgressToTarget" }, { target })}
      />

      <ol className="mt-2 grid grid-cols-2 gap-x-3 gap-y-2 sm:grid-cols-4">
        {MIGRATION_PROGRESS_STEPS.map((labelId, index) => {
          const stepComplete = completed || index < currentStep;
          const stepCurrent = !completed && index === currentStep;
          return (
            <li key={labelId} className="flex min-w-0 items-center gap-1.5 text-[11px] font-bold">
              <span
                className={`flex size-4 shrink-0 items-center justify-center border border-black text-[9px] ${
                  stepComplete
                    ? "bg-brutal-lime"
                    : stepCurrent
                      ? failed
                        ? "bg-brutal-orange"
                        : "bg-brutal-pink"
                      : "bg-white text-black/35"
                }`}
                aria-hidden="true"
              >
                {stepComplete ? <Check size={10} strokeWidth={3} /> : index + 1}
              </span>
              <span className={stepCurrent || stepComplete ? "text-black" : "text-black/40"}>
                {formatMessage({ id: labelId })}
              </span>
            </li>
          );
        })}
      </ol>

      <Banner
        intent={failed || notice.cancelNeedsAttention ? "warning" : completed ? "success" : "info"}
        density="sm"
        title={failed || cancelRequested ? presentation.title : undefined}
        aria-live="polite"
      >
        {failed || notice.cancelNeedsAttention
          ? <MigrationErrorContent presentation={presentation} />
          : presentation.message}
      </Banner>
      {completed ? (
        <div
          className="space-y-2 border border-black/15 bg-black/[0.03] p-2.5 text-xs text-black/70"
          data-testid="migration-completion-summary"
        >
          <p className="font-bold text-black">
            {formatMessage({ id: "agent.detail.migrationCompletionRoute" }, { source, target })}
          </p>
          <p>{formatMessage({ id: "agent.detail.migrationCompletionAuthority" })}</p>
          <p>{formatMessage({ id: "agent.detail.migrationSessionResetDetailed" })}</p>
        </div>
      ) : null}
      {active ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-[11px] text-black/45">
            {formatMessage({ id: "agent.detail.updatesAutomatically" })}
          </p>
          {canCancelMigration(notice) ? (
            <button
              type="button"
              onClick={onShowCancel}
              className="btn-brutal-sm flex items-center gap-1.5 bg-white px-2 py-1 text-xs font-bold"
            >
              <X size={12} aria-hidden="true" />
              {formatMessage({ id: "agent.migration.cancelAction" })}
            </button>
          ) : null}
        </div>
      ) : null}
      </SurfaceListItem>
    </section>
  );
}

function AgentMigrationCancelDialog({
  agentId,
  notice,
  machines,
  onClose,
  onRefresh,
}: {
  agentId: string;
  notice: MigrationNotice;
  machines: Machine[];
  onClose: () => void;
  onRefresh: () => Promise<void>;
}) {
  const { formatMessage } = useIntl();
  const source = migrationTargetLabel(formatMessage, machines, notice.sourceMachineId);
  const target = migrationTargetLabel(formatMessage, machines, notice.targetMachineId);
  const ref = migrationSupportRef(notice);

  const submit = async () => {
    if (!canCancelMigration(notice)) return;
    try {
      await api.post(`/agents/${agentId}/migration/cancel`, {
        migrationRef: ref,
        expectedRevision: notice.revision,
      });
      await onRefresh();
    } catch (nextError: unknown) {
      const value = nextError as {
        response?: { data?: { code?: string } };
      };
      const code = value.response?.data?.code;
      await onRefresh();
      const message = code === "MIGRATION_REVISION_STALE" || code === "MIGRATION_CONCURRENT_UPDATE"
        ? formatMessage({ id: "agent.migration.cancelDialogStaleError" })
        : formatMessage({ id: "agent.migration.cancelDialogGenericError" });
      const technicalCode = code && /^[A-Za-z][A-Za-z0-9_-]{1,127}$/.test(code) ? code : null;
      throw new Error(technicalCode ? `${message} (${technicalCode})` : message);
    }
  };

  return (
    <ConfirmDialog
      title={formatMessage({ id: "agent.migration.cancelDialogTitle" })}
      confirmLabel={formatMessage({ id: "agent.migration.cancelAction" })}
      loadingLabel={formatMessage({ id: "agent.migration.cancelDialogRequesting" })}
      cancelLabel={formatMessage({ id: "agent.migration.cancelDialogKeepAction" })}
      confirmIcon={<X size={14} aria-hidden="true" />}
      confirmColor="bg-brutal-orange"
      confirmDisabled={!canCancelMigration(notice)}
      maxWidthClass="max-w-md"
      plainMessage
      chromeLocale="active"
      onClose={onClose}
      onConfirm={submit}
      message={
        <div className="space-y-3">
          <Banner
            intent="warning"
            density="sm"
            title={formatMessage({ id: "agent.migration.cancelDialogSafetyTitle" })}
          >
            {formatMessage({ id: "agent.migration.cancelDialogSafeMessage" }, { source, target })}
          </Banner>
          <MigrationReference notice={notice} />
          <p className="text-xs text-black/60">
            {formatMessage({ id: "agent.migration.cancelDialogExplanation" })}
          </p>
        </div>
      }
    />
  );
}

function AgentMigrationDialog({
  agent,
  machines,
  sourceMachineId,
  onClose,
  onProRequired,
  onStarted,
}: {
  agent: Agent;
  machines: Machine[];
  sourceMachineId: string | null;
  onClose: () => void;
  onProRequired: () => void;
  onStarted: (result: MigrationStartResponse) => Promise<void>;
}) {
  const { formatMessage } = useIntl();
  const nav = useAppNavigate();
  const targetComputers = useMemo(() =>
    machines.filter((machine) =>
      machine.id !== sourceMachineId &&
      machine.isComputer === true
    ),
  [machines, sourceMachineId]);
  const targetComputerOptions = useMemo(() =>
    targetComputers.map((machine) => ({
      value: machine.id,
      label: machine.name,
    })),
  [targetComputers]);
  const [targetComputer, setTargetComputer] = useState(targetComputers[0]?.id ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<MigrationErrorPresentation | null>(null);
  const selectedTargetComputer = targetComputers.some((machine) => machine.id === targetComputer)
    ? targetComputer
    : targetComputers[0]?.id ?? "";
  const sourceComputerName = machines.find((machine) => machine.id === sourceMachineId)?.name;
  const targetComputerName = machines.find((machine) => machine.id === selectedTargetComputer)?.name;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedTargetComputer) return;
    setSubmitting(true);
    setError(null);
    try {
      const { data } = await api.post<MigrationStartResponse>(`/agents/${agent.id}/migrate`, {
        targetComputer: selectedTargetComputer,
      });
      await onStarted(data);
    } catch (err: unknown) {
      if (isMigrationProPlanRequiredError(err)) {
        onProRequired();
        return;
      }
      setError(migrationStartErrorPresentation(err, formatMessage, {
        sourceComputerName,
        targetComputerName,
        sourceComputerId: sourceMachineId,
        targetComputerId: selectedTargetComputer,
      }));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal onClose={onClose} closeOnBackdrop>
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-md border-2 border-black bg-white shadow-brutal"
      >
        <div className="flex items-center justify-between border-b-2 border-black px-4 py-3">
          <h2 className="text-base font-bold text-black">
            {formatMessage({ id: "agent.detail.moveToAnotherComputer" })}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="btn-brutal-sm flex size-7 items-center justify-center bg-white"
            title={formatMessage({ id: "common.close" })}
          >
            <X size={14} />
          </button>
        </div>
        <div className="space-y-4 p-4">
          <div>
            <label
              id="agent-migration-target-computer-label"
              className="mb-1 block text-xs font-bold uppercase tracking-wide text-black/55"
            >
              {formatMessage({ id: "agent.detail.targetComputer" })}
            </label>
            <Select
              value={selectedTargetComputer || null}
              onValueChange={(value) => {
                if (value == null) return;
                setTargetComputer(value);
              }}
              disabled={submitting || targetComputers.length === 0}
              items={targetComputerOptions}
            >
              <SelectTrigger
                className="w-full"
                aria-labelledby="agent-migration-target-computer-label"
              >
                <SelectValue placeholder={formatMessage({ id: "agent.detail.noOtherAttachedComputer" })} />
                <SelectIcon />
              </SelectTrigger>
              <SelectContent>
                <SelectList>
                  {targetComputerOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      <SelectItemText>{option.label}</SelectItemText>
                      <SelectItemIndicator />
                    </SelectItem>
                  ))}
                </SelectList>
              </SelectContent>
            </Select>
          </div>
          <div className="border border-black/15 bg-black/[0.03] p-2 text-xs font-bold text-black/60">
            {formatMessage({ id: "agent.detail.migrationModeStopBeforeExport" })}
          </div>
          <div className="border border-black/15 bg-black/[0.03] p-2 text-xs font-bold text-black/60">
            {formatMessage({ id: "agent.detail.migrationSessionResetDetailed" })}
          </div>
          {error ? (
            <Banner intent="warning" density="sm">
              <MigrationErrorContent presentation={error} />
            </Banner>
          ) : null}
        </div>
        <div className="flex justify-end gap-2 border-t-2 border-black bg-gray-50 px-4 py-3">
          {error?.recovery === "open_computers_and_retry" ? (
            <button
              type="button"
              onClick={() => {
                onClose();
                if (error.recoveryComputerId) {
                  nav.toComputer(error.recoveryComputerId);
                } else {
                  nav.toComputers();
                }
              }}
              className="btn-brutal bg-white px-3 py-2 text-sm font-bold"
              disabled={submitting}
            >
              {formatMessage({ id: "agent.migration.error.openComputers" })}
            </button>
          ) : null}
          <button
            type="button"
            onClick={onClose}
            className="btn-brutal bg-white px-3 py-2 text-sm font-bold"
            disabled={submitting}
          >
            {formatMessage({ id: "agent.detail.cancel" })}
          </button>
          <button
            type="submit"
            className="btn-brutal bg-brutal-lime px-3 py-2 text-sm font-bold disabled:cursor-not-allowed disabled:opacity-50"
            disabled={submitting || !selectedTargetComputer}
          >
            {submitting
              ? formatMessage({ id: "agent.detail.starting" })
              : error?.recovery === "open_computers_and_retry"
                ? formatMessage({ id: "agent.migration.error.tryAgain" })
                : formatMessage({ id: "agent.detail.startMigration" })}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function AgentMigrationUpgradeDialog({
  onClose,
  onViewPlans,
}: {
  onClose: () => void;
  onViewPlans: () => void;
}) {
  const { formatMessage } = useIntl();
  return (
    <ConfirmDialog
      title={formatMessage({ id: "agent.migration.proRequired.title" })}
      message={(
        <div className="space-y-3 text-sm leading-relaxed text-black/75">
          <p>{formatMessage({ id: "agent.migration.proRequired.description" })}</p>
          <p className="font-bold text-black">
            {formatMessage({ id: "agent.migration.proRequired.preservedAccess" })}
          </p>
        </div>
      )}
      confirmLabel={formatMessage({ id: "agent.migration.proRequired.viewPlans" })}
      confirmColor="bg-brutal-lime"
      onConfirm={onViewPlans}
      onClose={onClose}
      plainMessage
      chromeLocale="active"
      maxWidthClass="max-w-md"
    />
  );
}

// Isolated header component — only re-renders on activity changes for this agent,
// without triggering re-render of ChatPanel / tabs below.
function AgentDetailHeader({ agent, canControlAgentRuntime, canMessageAgent, onMessage, onClose, onBack, onShowResetDialog, onShowStopConfirm, workspaceEmbedded = false, headerActionsHost = null }: {
  agent: Agent;
  canControlAgentRuntime: boolean;
  canMessageAgent: boolean;
  onMessage: () => void;
  onClose?: () => void;
  onBack?: () => void;
  onShowResetDialog: () => void;
  onShowStopConfirm: () => void;
  workspaceEmbedded?: boolean;
  headerActionsHost?: Element | null;
}) {
  const { formatMessage } = useIntl();
  const slug = useServerStore((s) => s.current?.slug);
  // Two render modes for AgentDetailPanel:
  //   - Standalone route `/agent/<id>` — back falls back to /members rail.
  //   - Overlay (`?profile=agent:<id>` driven by ProfilePanel + useProfileStore)
  //     — `onClose` is closeProfile; back should close the overlay so the
  //     user lands on the underlying channel/DM, NOT skip to /members.
  // See useMobileBack JSDoc for the cold-start permalink scenario fixed
  // by this branch (#proj-mobile:b1c622e5 stdrc 2026-05-08).
  const responsiveBack = useMobileBack(onClose ?? (slug ? `/s/${slug}/members` : "/"));
  const headerBack = onBack ?? responsiveBack;
  const displayState = useAgentDisplayState(agent.id, agent);
  const currentServerId = useServerStore((s) => s.current?.id);
  const topbarOverflowEnabled = useServerFeatureFlag(
    TOPBAR_OVERFLOW_FEATURE_FLAG_KEY,
  ).enabled;
  const startAgent = useAgentStore((s) => s.startAgent);
  const isOnline = displayState.isOnline;
  const isDeleted = !!agent.deletedAt;
  const isExternalAgent = agent.external === true || isExternalAgentRuntime(agent.runtime);
  // Pinned by agentVisibility.test.ts as the...
  // stay in member-view mode" contract. Currently the rendered JSX dropped
  // the surfacing branch in a recent layout pass, so the value is unread —
  // `void` keeps it lint-clean without breaking the contract test that
  // guards the source-server resolution shape for future re-introduction.
  const sourceServerLabel =
    currentServerId && agent.serverId && agent.serverId !== currentServerId
      ? agent.serverName || agent.serverSlug || null
      : null;
  void sourceServerLabel;
  const [showMobileActions, setShowMobileActions] = useState(false);
  const mobileMenuRef = useRef<HTMLDivElement | null>(null);
  const mobileActionsPopupRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!showMobileActions) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (mobileMenuRef.current && !mobileMenuRef.current.contains(event.target as Node)) {
        setShowMobileActions(false);
      }
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setShowMobileActions(false);
    };
    document.addEventListener("mousedown", handlePointerDown);
    // keydown-focus-on-open
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [showMobileActions]);

  // Move focus to the first action when the mobile actions menu opens, like the
  // other popovers/menus — so Escape/keys reach it and a background element
  // can't swallow them. (Same focus-on-open contract as ServerSwitcherMenu.)
  useLayoutEffect(() => {
    if (!showMobileActions) return;
    mobileActionsPopupRef.current?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
  }, [showMobileActions]);

  const handleStartStop = () => {
    if (isOnline) onShowStopConfirm();
    else void startAgent(agent.id);
  };

  // Flag off preserves the pre-#187 desktop action row and its compact mobile
  // popover. Flag on matches the Thread topbar: immediate commands live in a
  // single Raft UI DropdownMenu, while structural Close remains outside.
  const legacyActions = !isDeleted ? (
    <>
      {canMessageAgent && (
        <button
          onClick={onMessage}
          className="btn-brutal-sm flex size-7 items-center justify-center bg-white"
          title={formatMessage({ id: "agent.detail.messages" })}
          aria-label={formatMessage({ id: "agent.detail.messages" })}
        >
          <MessageSquare size={14} />
        </button>
      )}
      {canControlAgentRuntime && !isExternalAgent && (
        <>
          <div className="relative md:hidden" ref={mobileMenuRef}>
            <button
              type="button"
              onClick={() => setShowMobileActions((value) => !value)}
              className="btn-brutal-sm flex size-7 items-center justify-center bg-white"
              title={formatMessage({ id: "agent.detail.moreActions" })}
            >
              <Menu size={14} />
            </button>
            {showMobileActions && (
              <div ref={mobileActionsPopupRef} className="absolute right-0 top-full z-20 mt-2 min-w-[180px] border-2 border-black bg-white shadow-brutal">
                <button
                  type="button"
                  onClick={() => {
                    setShowMobileActions(false);
                    handleStartStop();
                  }}
                  className="flex w-full items-center gap-2 border-b border-black/10 px-3 py-2 text-left text-sm font-bold hover:bg-black/5"
                >
                  {isOnline ? <Square size={14} /> : <Play size={14} />}
                  <span>
                    {isOnline
                      ? formatMessage({ id: "agent.detail.stopAgent" })
                      : formatMessage({ id: "agent.detail.startAgent" })}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowMobileActions(false);
                    onShowResetDialog();
                  }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-bold hover:bg-black/5"
                >
                  <RotateCcw size={14} />
                  <span>{formatMessage({ id: "agent.detail.restartReset" })}</span>
                </button>
              </div>
            )}
          </div>
          <button
            onClick={handleStartStop}
            className="btn-brutal-sm hidden size-7 items-center justify-center bg-white md:flex"
            title={isOnline
              ? formatMessage({ id: "agent.detail.stopAgent" })
              : formatMessage({ id: "agent.detail.startAgent" })}
          >
            {isOnline ? <Square size={14} /> : <Play size={14} />}
          </button>
          <button
            onClick={onShowResetDialog}
            className="btn-brutal-sm hidden size-7 items-center justify-center bg-white md:flex"
            title={formatMessage({ id: "agent.detail.restartReset" })}
          >
            <RotateCcw size={14} />
          </button>
        </>
      )}
    </>
  ) : null;
  const overflowActions = !isDeleted ? (
    <AgentProfileOverflowMenu
      canMessageAgent={canMessageAgent}
      canControlAgentRuntime={canControlAgentRuntime && !isExternalAgent}
      isOnline={isOnline}
      messageLabel={formatMessage({ id: "agent.detail.directMessage" })}
      onMessage={onMessage}
      onStartStop={handleStartStop}
      onRestartReset={onShowResetDialog}
      responsive
    />
  ) : null;
  const actions = (
    <>
      {topbarOverflowEnabled ? overflowActions : legacyActions}
      {onClose && (
        <button
          onClick={onClose}
          className={`btn-brutal-sm size-7 items-center justify-center bg-white ${onBack ? "flex" : "hidden md:flex"}`}
          title={formatMessage({ id: "common.close" })}
        >
          <X size={14} />
        </button>
      )}
    </>
  );

  if (workspaceEmbedded) {
    if (!headerActionsHost) return null;
    const workspaceActions = (
      <div className="workspace-grid-tabset-actions" data-testid="workspace-grid-agent-actions">
        {topbarOverflowEnabled && !isDeleted ? (
          <AgentProfileOverflowMenu
            canMessageAgent={canMessageAgent}
            canControlAgentRuntime={canControlAgentRuntime && !isExternalAgent}
            isOnline={isOnline}
            messageLabel={formatMessage({ id: "agent.detail.directMessage" })}
            onMessage={onMessage}
            onStartStop={handleStartStop}
            onRestartReset={onShowResetDialog}
            responsive
          />
        ) : (
          <>
            {!isDeleted && canMessageAgent && (
              <button
                onClick={onMessage}
                className="btn-brutal-sm flex size-7 items-center justify-center bg-white"
                title={formatMessage({ id: "agent.detail.message" })}
                aria-label={formatMessage({ id: "agent.detail.message" })}
              >
                <MessageSquare size={14} />
              </button>
            )}
            {!isDeleted && canControlAgentRuntime && !isExternalAgent && (
              <>
                <button
                  onClick={handleStartStop}
                  className="btn-brutal-sm flex size-7 items-center justify-center bg-white"
                  title={isOnline
                    ? formatMessage({ id: "agent.detail.stopAgent" })
                    : formatMessage({ id: "agent.detail.startAgent" })}
                  aria-label={isOnline
                    ? formatMessage({ id: "agent.detail.stopAgent" })
                    : formatMessage({ id: "agent.detail.startAgent" })}
                >
                  {isOnline ? <Square size={14} /> : <Play size={14} />}
                </button>
                <button
                  onClick={onShowResetDialog}
                  className="btn-brutal-sm flex size-7 items-center justify-center bg-white"
                  title={formatMessage({ id: "agent.detail.restartReset" })}
                  aria-label={formatMessage({ id: "agent.detail.restartReset" })}
                >
                  <RotateCcw size={14} />
                </button>
              </>
            )}
          </>
        )}
      </div>
    );
    return createPortal(workspaceActions, headerActionsHost);
  }

  return (
    <PanelHeader
      onMobileBack={headerBack}
      backButtonVisibility={onBack ? "always" : "responsive"}
      mobileBackProps={{ "data-testid": "agent-mobile-back", title: formatMessage({ id: "common.announcement.back" }) }}
      iconSlot={
        <AvatarSlot
          context="panel-header"
          type="agent"
          agentAvatarUrl={agent.avatarUrl}
          className={isDeleted ? "grayscale opacity-60" : ""}
        />
      }
      iconAlwaysVisible
      title={agent.displayName || agent.name}
      subtitle={agent.description && !isDeleted ? agent.description : undefined}
      titleClickProps={{ title: agent.displayName || agent.name }}
      titleSuffix={
        isDeleted ? (
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="inline-flex shrink-0 items-center px-1.5 py-0.5 text-[10px] font-bold uppercase border border-black bg-gray-300 text-black/60">
              {formatMessage({ id: "agent.detail.deleted" })}
            </span>
          </div>
        ) : undefined
      }
      containerProps={{ className: "agent-profile-header-container" }}
      actions={actions}
    />
  );
}

export default function AgentDetailPanel({ agent, onClose, onBack, onOpenProfile, workspaceEmbedded = false, headerActionsHost = null }: { agent: Agent; onClose?: () => void; onBack?: () => void; onOpenProfile?: (type: "agent" | "human", id: string) => void; workspaceEmbedded?: boolean; headerActionsHost?: Element | null }) {
  const { formatMessage } = useIntl();
  const formatMessageRef = useRef(formatMessage);
  formatMessageRef.current = formatMessage;
  const stopAgent = useAgentStore((s) => s.stopAgent);
  const deleteAgent = useAgentStore((s) => s.deleteAgent);
  const updateAgent = useAgentStore((s) => s.updateAgent);
  const openDM = useChannelStore((s) => s.openDM);
  const { role: currentRole, capabilities } = useServerPermissions();
  const nav = useAppNavigate();
  const activityState = useAgentCurrentActivityState(agent.id);
  const activityLog = useAgentStore((s) => s.activityLogs[agent.id] ?? EMPTY_ACTIVITY_LOG);
  const machines = useMachineStore((s) => s.machines);
  const currentServer = useServerStore((s) => s.current);
  const billing = useServerStore((s) => s.billing);
  const loadingBilling = useServerStore((s) => s.loadingBilling);
  const loadBilling = useServerStore((s) => s.loadBilling);
  const currentUser = useAuthStore((s) => s.user);
  const agentMachine = agent.machineId ? machines.find((m) => m.id === agent.machineId) : null;
  const isRemoteJointAgent = Boolean(currentServer?.id && agent.serverId && agent.serverId !== currentServer.id);
  const isBoundedPublicProjection = isRemoteJointAgent || agent.profileProjection === "channel_summary";
  const isExternalAgent = agent.external === true || isExternalAgentRuntime(agent.runtime);
  const agentMigrationUiEnabled = useAgentMigrationUiEnabled();

  const [showAvatarPicker, setShowAvatarPicker] = useState(false);
  const [avatarPickerError, setAvatarPickerError] = useState("");
  const [startError, setStartError] = useState("");
  const [showResetDialog, setShowResetDialog] = useState(false);
  const [showReportDialog, setShowReportDialog] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showStopConfirm, setShowStopConfirm] = useState(false);
  const [showMigrationDialog, setShowMigrationDialog] = useState(false);
  const [showMigrationUpgradeDialog, setShowMigrationUpgradeDialog] = useState(false);
  const [showMigrationCancel, setShowMigrationCancel] = useState(false);
  const fetchExternalAgentStatus = useAgentStore((s) => s.fetchExternalAgentStatus);
  const [panelExternalStatus, setPanelExternalStatus] = useState<ExternalAgentStatus | null>(null);
  const canManageAgent = !isBoundedPublicProjection && canViewAgentPrivateSurfaces(
    agent,
    currentUser?.id,
    capabilities.editAgents,
  );
  const canControlAgentRuntime = !isBoundedPublicProjection && !isExternalAgent && canViewAgentPrivateSurfaces(
    agent,
    currentUser?.id,
    capabilities.controlAgentRuntime,
  );
  const canResetAgentWorkspace = !isBoundedPublicProjection && !isExternalAgent && canViewAgentPrivateSurfaces(
    agent,
    currentUser?.id,
    capabilities.resetAgentWorkspace,
  );
  const canManageServer = !isBoundedPublicProjection && capabilities.manageExternalAuth;
  const canChangeAgentRole = !isBoundedPublicProjection && capabilities.changeMemberRoles;
  const migrationStatusEnabled = agentMigrationUiEnabled && canManageAgent && !isExternalAgent && !isBoundedPublicProjection;
  const presentMigrationStatusError = useCallback(
    (error: { code?: string; message?: string }) => migrationStatusErrorPresentation(error, formatMessage),
    [formatMessage],
  );
  const {
    model: migrationModel,
    error: currentAgentMigrationStatusError,
    refresh: refreshMigrationStatus,
  } = useAgentMigrationStatus({
    agentId: agent.id,
    enabled: migrationStatusEnabled,
    presentError: presentMigrationStatusError,
  });
  const currentAgentMigrationNotice = migrationModel.migration?.agentId === agent.id
    ? migrationModel.migration
    : null;
  const currentAgentMigrationActive = currentAgentMigrationNotice
    ? isActiveMigrationState(currentAgentMigrationNotice.state)
    : false;
  const migrationCanRetry = currentAgentMigrationNotice
    ? isFailedMigrationState(currentAgentMigrationNotice.state)
    : false;
  const migrationRequiresUpgrade = agentMigrationRequiresUpgrade(billing?.plan);
  const migrationBillingChecking = billing == null && loadingBilling;

  useEffect(() => {
    if (!agentMigrationUiEnabled || !canManageAgent || isExternalAgent || isBoundedPublicProjection) {
      return;
    }
    void loadBilling();
  }, [
    agentMigrationUiEnabled,
    canManageAgent,
    isExternalAgent,
    isBoundedPublicProjection,
    loadBilling,
  ]);

  useEffect(() => {
    if (!isExternalAgent || isBoundedPublicProjection) return;
    let canceled = false;
    const load = async () => {
      try {
        const status = await fetchExternalAgentStatus(agent.id);
        if (!canceled) setPanelExternalStatus(status);
      } catch {
        if (!canceled) setPanelExternalStatus(null);
      }
    };
    void load();
    return () => { canceled = true; };
  }, [agent.id, fetchExternalAgentStatus, isBoundedPublicProjection, isExternalAgent]);

  const diagnosticCopyController = useCopyText({
    resetKey: agent.id,
    timeoutMs: 2_000,
  });
  const [searchParams, setSearchParams] = useLiveSearchParams();
  const location = useLocation();
  const canViewPrivateAgentSurfaces = canViewAgentPrivateSurfaces(
    agent,
    currentUser?.id,
    canManageAgent,
  );
  const hasRuntimeError = activityState?.activity === "error" || Boolean(agent.lastRuntimeError);
  const rawRuntimeError = hasRuntimeError
    ? (activityState?.activity === "error" ? activityState.activityDetail : agent.lastRuntimeError?.message) ?? ""
    : "";
  // #688(d): surface the authoritative typed diagnostic (errorClass/reason/
  // fingerprint) that the daemon+server persisted, when present — instead of
  // re-deriving only from message text. Falls back to the message classifier
  // for untyped/legacy error authority.
  const typedRuntimeError =
    agent.lastRuntimeError?.errorClass && agent.lastRuntimeError.errorReason
      ? agent.lastRuntimeError
      : null;
  const typedRuntimeErrorErrKind: RuntimeErrorKind | null =
    typedRuntimeError && (typedRuntimeError.errorReason === "auth_failed" || typedRuntimeError.errorClass === "AuthError")
      ? "authFailed"
      : null;
  // Runtime-error sentinel: known stable runtime errors map to catalog copy;
  // unknown errors keep the raw text / generic fallback (never mistranslated).
  const runtimeErrorKind = typedRuntimeErrorErrKind ?? (rawRuntimeError ? classifyRuntimeError(rawRuntimeError) : null);
  const activityErrorText = runtimeErrorKind
    ? formatMessage({ id: RUNTIME_ERROR_LABEL_ID[runtimeErrorKind] })
    : hasRuntimeError
      ? formatActivityText(formatMessage, "error", rawRuntimeError)
      : formatMessage({ id: "activity.status.agentErrorFallback" });
  const activityFallbackErrorText = formatMessage({ id: "activity.status.agentErrorFallback" });
  // The raw diagnostic stays available for the copy button even when the
  // banner shows the classified catalog message.
  const diagnosticErrorMessage = hasRuntimeError && canViewPrivateAgentSurfaces
    ? (typedRuntimeError
      ? [rawRuntimeError, `class=${typedRuntimeError.errorClass} reason=${typedRuntimeError.errorReason} fingerprint=${typedRuntimeError.fingerprint}`].filter(Boolean).join("\n")
      : rawRuntimeError)

    : null;

  // Reactive cleanup: close the delete-confirm dialog if the agent gets
  // deleted externally (socket/another tab) while the dialog is open. The
  // setShowDeleteConfirm(false) is a deliberate response to a prop change,
  // not a mirror-prop pattern. Lifting the dialog state up would force a
  // wider refactor with no behavior benefit.
  useEffect(() => {
    // oxlint-disable-next-line react-doctor/no-event-handler -- YMNNE-family: pre-existing non-bug site grandfathered; rule now gates new code (see docs/frontend/render-cost-contract.md)
    if (agent.deletedAt && showDeleteConfirm) {
      // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change, react-doctor/no-chain-state-updates -- YMNNE-family: pre-existing non-bug site grandfathered; rule now gates new code (see docs/frontend/render-cost-contract.md)
      setShowDeleteConfirm(false);
    }
  }, [agent.deletedAt, showDeleteConfirm]);

  const visibleAgentTabs = useMemo(
    () => AGENT_TABS.filter((tab) => {
      if (PUBLIC_AGENT_TABS.has(tab)) return true;
      if (tab === "mcp") return canManageAgent;
      return canViewPrivateAgentSurfaces;
    }),
    [canManageAgent, canViewPrivateAgentSurfaces],
  );
  const visibleAgentTabItems = useMemo(
    () => AGENT_PANEL_TABS.filter((tab) => visibleAgentTabs.includes(tab.id)),
    [visibleAgentTabs],
  );
  const agentPanelTabOrder = useServerStore((s) => s.sidebarOrder.agentPanelTabOrder);
  const updateSidebarOrder = useServerStore((s) => s.updateSidebarOrder);
  const normalizedAgentPanelTabOrder = useMemo(
    () => agentPanelTabOrder.map((tab) => tab === "channels" || tab === "dms" ? "chat" : tab),
    [agentPanelTabOrder],
  );
  const orderedAgentTabs = useOrderedTabs(visibleAgentTabItems, normalizedAgentPanelTabOrder);
  const reorderAgentTabs = useCallback((nextOrder: AgentTab[]) => {
    void updateSidebarOrder({ agentPanelTabOrder: nextOrder });
  }, [updateSidebarOrder]);
  const orderedAgentTabIds = useMemo(() => orderedAgentTabs.map((tab) => tab.id), [orderedAgentTabs]);
  const orderedAgentTabKey = orderedAgentTabIds.join("|");
  const defaultAgentTab: AgentTab = visibleAgentTabs.includes("profile")
    ? "profile"
    : visibleAgentTabs[0] ?? "profile";
  const rawTab = searchParams.get("agentTab");
  const isFullPageAgentRoute = /^\/s\/[^/]+\/agent\/[^/]+$/.test(location.pathname);
  const legacyFullPageTab = isFullPageAgentRoute ? searchParams.get("tab") : null;
  const resolvedTab = rawTab ?? legacyFullPageTab;
  const activeTab: AgentTab = orderedAgentTabs.some((tab) => tab.id === resolvedTab) ? (resolvedTab as AgentTab) : defaultAgentTab;
  const agentTabsRef = useRef<HTMLDivElement | null>(null);
  const setActiveTab = useCallback((tab: AgentTab) => {
    // Agent detail tabs keep their own scoped query key. We still strip the
    // legacy generic `tab` when it holds an old agent- or sidebar-tab value so
    // old shared URLs normalize onto `agentTab` + `sidebarTab`.
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (tab === defaultAgentTab) next.delete("agentTab");
      else next.set("agentTab", tab);
      if (isFullPageAgentRoute) {
        const legacyTab = next.get("tab");
        if (legacyTab === "machines") {
          next.set(SIDEBAR_TAB_QUERY_PARAM, "members");
          next.delete("tab");
        } else if (legacyTab && AGENT_TABS.includes(legacyTab as AgentTab)) {
          next.delete("tab");
        }
      }
      return next;
    }, { replace: true });
  }, [defaultAgentTab, isFullPageAgentRoute, setSearchParams]);

  useLayoutEffect(() => {
    let frame = 0;
    const scrollActiveTabIntoView = () => {
      const tabsRoot = agentTabsRef.current;
      const tabsList = tabsRoot?.querySelector<HTMLElement>('[data-slot="tabs-list"]');
      const activeTabButton = tabsRoot?.querySelector<HTMLElement>(`[data-testid="panel-tab-${activeTab}"]`);
      if (!tabsList || !activeTabButton) return;

      const listRect = tabsList.getBoundingClientRect();
      const buttonRect = activeTabButton.getBoundingClientRect();
      const targetScrollLeft =
        tabsList.scrollLeft +
        (buttonRect.left - listRect.left) -
        ((tabsList.clientWidth - activeTabButton.offsetWidth) / 2);
      const maxScrollLeft = Math.max(0, tabsList.scrollWidth - tabsList.clientWidth);
      tabsList.scrollLeft = Math.max(0, Math.min(targetScrollLeft, maxScrollLeft));
    };

    scrollActiveTabIntoView();
    frame = window.requestAnimationFrame(scrollActiveTabIntoView);
    return () => window.cancelAnimationFrame(frame);
  }, [activeTab, agent.id, orderedAgentTabKey]);

  // Find existing DM channel for this agent (for Message button)
  const dmChannels = useChannelStore((s) => s.dmChannels);
  const dmChannel = useMemo(
    () => dmChannels.find((c) => c.peerId === agent.id),
    [dmChannels, agent.id]
  );

  const getDiagnosticInfo = useCallback(() => buildAgentDiagnosticInfo({
    agent,
    serverId: currentServer?.id,
    machine: agentMachine,
    activityState,
    activityLog,
    errorMessage: diagnosticErrorMessage,
    formatMessage,
  }), [activityLog, activityState, agent, agentMachine, currentServer?.id, diagnosticErrorMessage, formatMessage]);
  const handleDiagnosticCopyError = useCallback(() => {
    setStartError(formatMessage({ id: "agent.detail.copyDiagnosticInfoFailed" }));
  }, [formatMessage]);

  const currentPixelKey = parsePixelAvatar(agent.avatarUrl);
  const [reminderItems, setReminderItems] = useState<ReminderSummary[]>([]);
  const [remindersLoading, setRemindersLoading] = useState(true);
  const [remindersError, setRemindersError] = useState<string | null>(null);

  // Reminders are a PRIVATE agent surface. A peer-server agent's public profile
  // must not make this server fetch them, and a caught error is not the same as
  // a request that was never sent. The scope key also fences stale responses: an
  // in-flight load started for one (viewer server, agent) must never commit
  // after a switch. (task #21)
  const reminderScopeKey = `${currentServer?.id ?? ""}:${agent.id}`;
  const reminderScopeRef = useRef(reminderScopeKey);
  reminderScopeRef.current = reminderScopeKey;

  const loadReminders = useCallback(async () => {
    if (!canViewPrivateAgentSurfaces) {
      // Clear rather than leave a previous agent's private reminders on screen.
      setReminderItems([]);
      setRemindersError(null);
      setRemindersLoading(false);
      return;
    }
    // Capture the key ITSELF, not a ref read: that is what makes it a real
    // input to this callback (the lint was right — a dependency the body never
    // uses is not a dependency). The ref is only for the post-await comparison.
    const startedScope = reminderScopeKey;
    // Drop the previous scope's rows BEFORE awaiting. Re-issuing the request is
    // not enough: while the new scope loads, stale private rows from the old
    // server stayed on screen.
    setReminderItems([]);
    setRemindersLoading(true);
    setRemindersError(null);
    try {
      const { data } = await api.get("/reminders", {
        params: {
          ownerAgentId: agent.id,
          status: "scheduled",
        },
      });
      if (reminderScopeRef.current !== startedScope) return;
      setReminderItems((data?.reminders ?? []) as ReminderSummary[]);
    } catch (err: any) {
      if (reminderScopeRef.current !== startedScope) return;
      setRemindersError(err.response?.data?.error || formatMessageRef.current({ id: "agent.detail.loadRemindersFailed" }));
    } finally {
      if (reminderScopeRef.current === startedScope) setRemindersLoading(false);
    }
    // `reminderScopeKey` is a DEPENDENCY, not just a ref read: the viewer server
    // is part of load ownership, so switching servers must re-run this loader
    // even when the private-permission boolean happens to be unchanged.
    // Without it the ref updates but nothing reloads, and stale rows/loading
    // survive the switch. (task #21 review)
  }, [agent.id, canViewPrivateAgentSurfaces, reminderScopeKey]);

  // Async-loader: kicks `loadReminders` on mount + agent change. Same FP
  // family as PR #2530's useChannelMembers / AgentSkills async loaders.
  // oxlint-disable-next-line react-doctor/no-cascading-set-state
  useEffect(() => {
    void loadReminders();
  }, [loadReminders]);

  // Socket listener: handles fire/snooze/cancel/update events for the active
  // agent's reminders. Three setState calls inside the event handlers are
  // reactive to server-pushed events, NOT a derived-from-prop pattern.
  // oxlint-disable-next-line react-doctor/no-cascading-set-state
  useEffect(() => {
    // Same gate as the loader: no private socket subscriptions or reconnect
    // refetch for a peer-server agent's public profile.
    if (!canViewPrivateAgentSurfaces) return;
    const socket = getSocket();
    // Fire: one-shot reminders disappear; recurring reminders stay in the list
    // but advance to the next scheduled fire time (server sends nextFireAt).
    const handleReminderFired = (data: {
      reminderId: string;
      ownerAgentId: string;
      nextFireAt?: string | null;
    }) => {
      if (data.ownerAgentId !== agent.id) return;
      setReminderItems((current) => {
        if (!data.nextFireAt) {
          return current.filter((item) => item.reminderId !== data.reminderId);
        }
        return current.map((item) =>
          item.reminderId === data.reminderId ? { ...item, fireAt: data.nextFireAt! } : item,
        );
      });
    };
    const handleReminderScheduled = (data: { reminder: ReminderSummary }) => {
      if (data.reminder?.ownerAgentId !== agent.id) return;
      setReminderItems((current) => {
        // Ignore non-scheduled payloads defensively; only scheduled reminders
        // belong in the pending list (the API query filters status=scheduled).
        if (data.reminder.status !== "scheduled") return current;
        // Upsert: replace if we already have this id, else append + sort asc
        // by fireAt so the next-firing reminder stays on top.
        const without = current.filter((item) => item.reminderId !== data.reminder.reminderId);
        const next = [...without, data.reminder];
        next.sort((a, b) => a.fireAt.localeCompare(b.fireAt));
        return next;
      });
    };
    const handleReminderCanceled = (data: { reminderId: string; ownerAgentId: string }) => {
      if (data.ownerAgentId !== agent.id) return;
      setReminderItems((current) => current.filter((item) => item.reminderId !== data.reminderId));
    };
    const handleReconnect = () => {
      void loadReminders();
    };

    socket.on("reminder:fired", handleReminderFired);
    socket.on("reminder:scheduled", handleReminderScheduled);
    socket.on("reminder:canceled", handleReminderCanceled);
    socket.on("connect", handleReconnect);
    return () => {
      socket.off("reminder:fired", handleReminderFired);
      socket.off("reminder:scheduled", handleReminderScheduled);
      socket.off("reminder:canceled", handleReminderCanceled);
      socket.off("connect", handleReconnect);
    };
  }, [agent.id, canViewPrivateAgentSurfaces, reminderScopeKey, loadReminders]);

  const handleOpenReminderMsgRef = useCallback(
    (permalink: string) => {
      const parsed = parseRaftPermalink(permalink, window.location.hostname);
      if (!parsed) {
        // Anchor outside the app (shouldn't happen — msgPermalink is
        // server-built against APP_URL) — fall back to a full navigation.
        window.location.href = permalink;
        return;
      }
      if (parsed.threadParentMessageId) {
        nav.toThreadMessage(
          parsed.channelId,
          parsed.threadParentMessageId,
          parsed.messageId,
          parsed.routeKind,
        );
      } else if (parsed.routeKind === "dm") {
        nav.toDmMessage(parsed.channelId, parsed.messageId);
      } else {
        nav.toMessage(parsed.channelId, parsed.messageId);
      }
    },
    [nav],
  );

  const handleRetryReminders = useCallback(async () => {
    await loadReminders();
  }, [loadReminders]);

  const handleStop = async () => {
    setStartError("");
    try {
      await stopAgent(agent.id);
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: { error?: string } } };
      setStartError(axiosErr.response?.data?.error || formatMessage({ id: "agent.detail.stopAgentFailed" }));
    }
  };

  const handleDelete = async () => {
    await deleteAgent(agent.id);
    setShowDeleteConfirm(false);
  };

  const handleSelectAvatar = async (key: string) => {
    setAvatarPickerError("");
    await updateAgent(agent.id, { avatarUrl: `pixel:${key}` });
    setShowAvatarPicker(false);
  };

  const handleUploadAvatar = async (file: File) => {
    if (isAvatarFileTooLarge(file)) {
      setAvatarPickerError(formatMessage({ id: "avatar.tooLarge" }, { maxLabel: formatMessage({ id: "common.fileSize.maxLabel5mb" }) }));
      return;
    }
    setAvatarPickerError("");
    const formData = new FormData();
    formData.append("avatar", file);
    try {
      const res = await api.post(`/agents/${agent.id}/avatar`, formData, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      // Server already saved avatarUrl — just update local store
      const updated = res.data;
      useAgentStore.setState((state) => ({
        agents: state.agents.map((a) => a.id === agent.id ? { ...a, ...updated } : a),
      }));
      setShowAvatarPicker(false);
    } catch (err: unknown) {
      setAvatarPickerError(isAvatarTooLargeError(err)
        ? formatMessage({ id: "avatar.tooLarge" }, { maxLabel: formatMessage({ id: "common.fileSize.maxLabel5mb" }) })
        : avatarUploadApiErrorMessage(err, formatMessage({ id: "agent.detail.uploadAvatarFailed" })));
    }
  };

  const handleClearAvatar = async () => {
    setAvatarPickerError("");
    await updateAgent(agent.id, { avatarUrl: null });
    setShowAvatarPicker(false);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Header — isolated component to prevent activity changes from re-rendering ChatPanel */}
      <AgentDetailHeader
        agent={agent}
        canControlAgentRuntime={canControlAgentRuntime}
        canMessageAgent={!isBoundedPublicProjection}
        onClose={onClose}
        onBack={onBack}
        onMessage={async () => {
          useProfileStore.getState().closeProfile();
          useThreadStore.getState().closeThread();
          if (dmChannel) {
            nav.toDm(dmChannel.id);
          } else if (!agent.deletedAt) {
            const ch = await openDM(agent.id);
            if (ch) nav.toDm(ch.id);
          }
        }}
        onShowResetDialog={() => setShowResetDialog(true)}
        onShowStopConfirm={() => setShowStopConfirm(true)}
        workspaceEmbedded={workspaceEmbedded}
        headerActionsHost={headerActionsHost}
      />

      {/* Start error */}
      {startError && (
        <div className="border-b-2 border-black bg-brutal-orange/20 px-5 py-2 flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-bold text-black" title={startError}>{startError}</span>
          <button
            onClick={() => setStartError("")}
            className="shrink-0 text-black/40 hover:text-black transition-colors"
          >
            <X size={14} />
          </button>
        </div>
      )}

      {/* Agent runtime error banner — error detail leaks via Socket.io
          `agent:activity` to all server members, so for non-creators we
          fall back to a generic message and hide the "View logs" link. */}
      {hasRuntimeError && (
        <div className="flex items-start gap-2 border-b-2 border-black bg-brutal-orange/20 px-5 py-2">
          <StatusDot tone="bg-brutal-orange" className="mt-[0.1875rem] shrink-0" />
          <span className="min-w-0 flex-1 line-clamp-2 break-words text-sm font-bold leading-snug text-black" title={canViewPrivateAgentSurfaces ? activityErrorText : activityFallbackErrorText}>
            {canViewPrivateAgentSurfaces
              ? activityErrorText
              : activityFallbackErrorText}
          </span>
          {canViewPrivateAgentSurfaces && (
            <div className="flex shrink-0 flex-wrap items-center justify-end gap-x-3 gap-y-1">
              <CopyButton
                controller={diagnosticCopyController}
                text={getDiagnosticInfo}
                onCopyError={handleDiagnosticCopyError}
              >
                {({ copied, disabled, onClick, onMouseDown }) => (
                  <button
                    type="button"
                    onClick={onClick}
                    onMouseDown={onMouseDown}
                    disabled={disabled}
                    className="inline-flex items-center gap-1 text-xs font-bold text-black/60 hover:text-black underline whitespace-nowrap"
                  >
                    {copied ? <Check size={12} /> : <Clipboard size={12} />}
                    {copied
                      ? formatMessage({ id: "agent.detail.copied" })
                      : formatMessage({ id: "agent.detail.copyInfo" })}
                  </button>
                )}
              </CopyButton>
              {activeTab !== "activity" && (
                <button
                  type="button"
                  onClick={() => setActiveTab("activity")}
                  className="text-xs font-bold text-black/60 hover:text-black underline whitespace-nowrap"
                >
                  {formatMessage({ id: "agent.detail.viewLogs" })}
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* Tab bar — horizontally scrollable */}
      <div
        ref={agentTabsRef}
        className={`min-w-0 max-w-full overflow-hidden ${workspaceEmbedded ? "workspace-grid-agent-secondary-nav" : ""}`}
      >
        <Tabs<AgentTab> value={activeTab} onValueChange={setActiveTab} className="border-b-2 border-black bg-white">
          <SortableTabsList<AgentTab>
            value={orderedAgentTabIds}
            onReorder={reorderAgentTabs}
            className="max-w-full border-y-0 border-l-0 border-r-2 border-black bg-white"
          >
            {orderedAgentTabs.map((tab) => {
              const Icon = tab.icon;
              return (
                <SortableTabsTab
                  key={tab.id}
                  value={tab.id}
                  data-testid={`panel-tab-${tab.id}`}
                  className="!cursor-default"
                >
                  <Icon size={12} />
                  <TabsLabel>{formatMessage({ id: tab.labelId })}</TabsLabel>
                </SortableTabsTab>
              );
            })}
          </SortableTabsList>
        </Tabs>
      </div>

      {/* Tab content — fills remaining space */}
      {activeTab === "profile" ? (
        <div className="flex-1 overflow-y-auto bg-white">
          {isRemoteJointAgent && (agent.serverName || agent.serverSlug) && (
            <div className="border-b border-black/10 px-5 py-3">
              <SectionEyebrow as="div" className="mb-1">
                {formatMessage({ id: "agent.detail.from" })}
              </SectionEyebrow>
              <div className="text-sm font-bold text-black">{agent.serverName || agent.serverSlug}</div>
            </div>
          )}
          {/* Profile header — avatar + name + status */}
          <div className="flex items-start gap-4 px-5 py-5">
            {canManageAgent ? (
              <button
                type="button"
                onClick={() => {
                  setAvatarPickerError("");
                  setShowAvatarPicker(!showAvatarPicker);
                }}
                className="group relative"
                title={formatMessage({ id: "agent.detail.changeAvatar" })}
              >
                <AvatarSlot context="profile-tile" type="agent" agentAvatarUrl={agent.avatarUrl} />
                <div className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity">
                  <Pencil size={18} className="text-white" />
                </div>
              </button>
            ) : isCustomAvatar(agent.avatarUrl) && !agent.deletedAt ? (
              <button
                type="button"
                onClick={() => useImageLightboxStore.getState().openImage(agent.avatarUrl!, agent.displayName || agent.name)}
                className="group relative"
                title={formatMessage({ id: "agent.detail.viewAvatar" })}
                aria-label={formatMessage({ id: "agent.detail.viewAvatar" })}
              >
                <AvatarSlot context="profile-tile" type="agent" agentAvatarUrl={agent.avatarUrl} />
              </button>
            ) : (
              <AvatarSlot
                context="profile-tile"
                type="agent"
                agentAvatarUrl={agent.avatarUrl}
                className={agent.deletedAt ? "grayscale opacity-60" : ""}
              />
            )}
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-2">
                <div className="min-w-0 truncate text-lg font-bold leading-tight text-black" title={agent.displayName || agent.name}>{agent.displayName || agent.name}</div>
                {!agent.deletedAt && <AgentStatusBadge agentId={agent.id} fallbackStatus={agent.status} showDetail={canViewPrivateAgentSurfaces} externalStatus={isExternalAgent ? panelExternalStatus : undefined} />}
              </div>
              <div className="truncate text-sm text-black/50 font-mono" title={`@${agent.name}`}>@{agent.name}</div>
            </div>
          </div>

          {/* Avatar picker — inline below avatar */}
          {canManageAgent && showAvatarPicker && (
            <div className="px-5 py-3 border-t border-black/10">
              <SectionEyebrow as="div" className="mb-2">
                {formatMessage({ id: "agent.detail.chooseAvatar" })}
              </SectionEyebrow>
              <div className="flex flex-wrap gap-2 justify-center">
                {/* Upload custom image */}
                <label
                  className={`flex size-10 items-center justify-center border-2 transition-colors ${isCustomAvatar(agent.avatarUrl)
                    ? "border-brutal-pink bg-brutal-pink/20"
                    : "border-black hover:border-brutal-pink"
                  }`}
                  title={formatMessage({ id: "agent.detail.uploadImage" })}
                >
                  {isCustomAvatar(agent.avatarUrl) ? (
                    <img src={agent.avatarUrl!} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <Upload size={16} className="text-black/60" />
                  )}
                  <input
                    type="file"
                    accept={PROFILE_AVATAR_ACCEPT}
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      e.currentTarget.value = "";
                      if (file) handleUploadAvatar(file);
                    }}
                  />
                </label>
                <button
                  type="button"
                  onClick={handleClearAvatar}
                  className={`flex size-10 items-center justify-center border-2 overflow-hidden transition-colors ${!currentPixelKey && !isCustomAvatar(agent.avatarUrl)
                    ? "border-brutal-pink bg-brutal-pink/20"
                    : "border-black hover:border-brutal-pink"
                    }`}
                  title={formatMessage({ id: "agent.detail.defaultRobotAvatar" })}
                >
                  <PixelAvatar avatarKey={DEFAULT_AVATAR_KEY} size={36} />
                </button>
                {AVATAR_KEYS.filter((key) => key !== DEFAULT_AVATAR_KEY).map((key) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => handleSelectAvatar(key)}
                    className={`flex size-10 items-center justify-center border-2 overflow-hidden transition-colors ${currentPixelKey === key
                      ? "border-brutal-pink bg-brutal-pink/20"
                      : "border-black hover:border-brutal-pink"
                      }`}
                    title={key}
                  >
                    <PixelAvatar avatarKey={key} size={36} />
                  </button>
                ))}
              </div>
              {avatarPickerError ? (
                <p className="mt-2 text-center text-xs font-bold text-brutal-red" role="alert">
                  {avatarPickerError}
                </p>
              ) : null}
            </div>
          )}

          {/* Profile info: description, computer, created */}
          <AgentProfileInfo
            agent={agent}
            canManageAgent={canManageAgent && !agent.deletedAt}
            canChangeAgentRole={canChangeAgentRole && !agent.deletedAt}
            onOpenProfile={onOpenProfile}
            showOperationalInfo={!isBoundedPublicProjection}
          />

          {/* Skills */}
          {canViewPrivateAgentSurfaces && (
            <div className="border-t border-black/10">
              <AgentSkills agentId={agent.id} embedded />
            </div>
          )}

          {/* Actions */}
          {canManageAgent && !agent.deletedAt && (
            <div className="px-5 py-4 border-t border-black/10">
              <SectionEyebrow as="div" className="mb-3">
                {formatMessage({ id: "agent.detail.actions" })}
              </SectionEyebrow>
              <div className="space-y-2">
                {!isExternalAgent && (
                  <>
                    {agentMigrationUiEnabled && agent.machineId ? (
                      <>
                        <button
                          type="button"
                          onClick={() => {
                            if (migrationRequiresUpgrade) {
                              setShowMigrationUpgradeDialog(true);
                              return;
                            }
                            setShowMigrationDialog(true);
                          }}
                          disabled={currentAgentMigrationActive || migrationBillingChecking}
                          aria-busy={migrationBillingChecking}
                          className="btn-brutal flex w-full items-center justify-center gap-2 bg-brutal-lime px-4 py-2 text-sm font-bold disabled:cursor-not-allowed disabled:opacity-55"
                        >
                          {currentAgentMigrationActive ? (
                            <Spinner size="sm" aria-hidden="true" />
                          ) : (
                            <MoveRight size={14} aria-hidden="true" />
                          )}
                          {currentAgentMigrationActive
                            ? formatMessage({ id: "agent.detail.migrationInProgress" })
                            : migrationCanRetry
                              ? formatMessage({ id: "agent.detail.tryMigrationAgain" })
                              : formatMessage({ id: "agent.detail.moveToAnotherComputer" })}
                        </button>
                        {currentAgentMigrationNotice ? (
                          <MigrationProgressPanel
                            notice={currentAgentMigrationNotice}
                            machines={machines}
                            onShowCancel={() => setShowMigrationCancel(true)}
                          />
                        ) : null}
                        {currentAgentMigrationStatusError ? (
                          <Banner
                            intent="warning"
                            density="sm"
                            title={formatMessage({ id: "agent.detail.migrationStatusUnavailable" })}
                          >
                            <MigrationErrorContent presentation={currentAgentMigrationStatusError} />
                          </Banner>
                        ) : null}
                      </>
                    ) : null}
                    <AgentStartStopButton agentId={agent.id} onShowStopConfirm={() => setShowStopConfirm(true)} />
                    <button
                      onClick={() => setShowResetDialog(true)}
                      className="btn-brutal flex w-full items-center justify-center gap-2 bg-white px-4 py-2 text-sm font-bold"
                    >
                      <RotateCcw size={14} />
                      {formatMessage({ id: "agent.detail.restartReset" })}
                    </button>
                  </>
                )}
                <CopyButton
                  controller={diagnosticCopyController}
                  text={getDiagnosticInfo}
                  onCopyError={handleDiagnosticCopyError}
                >
                  {({ copied, disabled, onClick, onMouseDown }) => (
                    <button
                      onClick={onClick}
                      onMouseDown={onMouseDown}
                      disabled={disabled}
                      className="btn-brutal flex w-full items-center justify-center gap-2 bg-white px-4 py-2 text-sm font-bold"
                    >
                      {copied ? <Check size={14} /> : <Clipboard size={14} />}
                      {copied
                        ? formatMessage({ id: "agent.detail.diagnosticInfoCopied" })
                        : formatMessage({ id: "agent.detail.copyDiagnosticInfo" })}
                    </button>
                  )}
                </CopyButton>
                {FEEDBACK_EXPORT_ENABLED && (
                  <button
                    onClick={() => setShowReportDialog(true)}
                    className="btn-brutal flex w-full items-center justify-center gap-2 bg-brutal-orange px-4 py-2 text-sm font-bold"
                  >
                    <Bug size={14} />
                    {formatMessage({ id: "agent.reportIssue.title" })}
                  </button>
                )}
                <button
                  onClick={() => setShowDeleteConfirm(true)}
                  className="btn-brutal flex w-full items-center justify-center gap-2 bg-brutal-red px-4 py-2 text-sm font-bold"
                >
                  <Trash2 size={14} />
                  {formatMessage({ id: "agent.detail.deleteAgent" })}
                </button>
              </div>
            </div>
          )}
        </div>
      ) : activeTab === "chat" ? (
        <AgentChatTab key={agent.id} agentId={agent.id} />
      ) : activeTab === "reminders" ? (
        <AgentRemindersSection
          variant="tab"
          reminders={reminderItems}
          loading={remindersLoading}
          error={remindersError}
          onRetry={handleRetryReminders}
          onOpenMsgRef={handleOpenReminderMsgRef}
        />
      ) : activeTab === "workspace" ? (
        <AgentWorkspace agentId={agent.id} compact={!!onClose} />
      ) : activeTab === "activity" ? (
        <div className="flex min-h-0 flex-1 flex-col bg-white">
          <div className="flex items-center justify-between border-b-2 border-black bg-white px-5 py-2">
            <SectionEyebrow as="div">{formatMessage({ id: "agent.detail.activityDiagnostics" })}</SectionEyebrow>
            <CopyButton
              controller={diagnosticCopyController}
              text={getDiagnosticInfo}
              onCopyError={handleDiagnosticCopyError}
            >
              {({ copied, disabled, onClick, onMouseDown }) => (
                <button
                  type="button"
                  onClick={onClick}
                  onMouseDown={onMouseDown}
                  disabled={disabled}
                  className="btn-brutal-sm flex items-center gap-1.5 bg-white px-2 py-1 text-xs font-bold"
                >
                  {copied ? <Check size={12} /> : <Clipboard size={12} />}
                  {copied
                    ? formatMessage({ id: "agent.detail.copied" })
                    : formatMessage({ id: "agent.detail.copyDiagnosticInfo" })}
                </button>
              )}
            </CopyButton>
          </div>
          <AgentActivityLog agentId={agent.id} />
        </div>
      ) : activeTab === "integrations" ? (
        <AgentIntegrationsTab agentId={agent.id} canManageServer={canManageServer} />
      ) : activeTab === "mcp" ? (
        <AgentMcpTab agentId={agent.id} canManageServer={canManageServer} />
      ) : null}

      {canControlAgentRuntime && showResetDialog && (
        <ResetAgentDialog
          agentId={agent.id}
          agentName={agent.displayName || agent.name}
          canFullReset={canResetAgentWorkspace}
          memberRuntimeOnly={currentRole === "member"}
          onClose={() => setShowResetDialog(false)}
        />
      )}

      {canManageAgent && showReportDialog && (
        <ReportIssueDialog
          agent={agent}
          dmChannelId={dmChannel?.id}
          onClose={() => setShowReportDialog(false)}
        />
      )}

      {canManageAgent && showMigrationDialog && (
        <AgentMigrationDialog
          agent={agent}
          machines={machines}
          sourceMachineId={agent.machineId ?? null}
          onClose={() => setShowMigrationDialog(false)}
          onProRequired={() => {
            setShowMigrationDialog(false);
            setShowMigrationUpgradeDialog(true);
            void loadBilling();
          }}
          onStarted={async () => {
            setShowMigrationDialog(false);
            await refreshMigrationStatus();
          }}
        />
      )}

      {canManageAgent && showMigrationUpgradeDialog && (
        <AgentMigrationUpgradeDialog
          onClose={() => setShowMigrationUpgradeDialog(false)}
          onViewPlans={() => nav.toSettings("billing")}
        />
      )}

      {canManageAgent && showMigrationCancel && currentAgentMigrationNotice && canCancelMigration(currentAgentMigrationNotice) && (
        <AgentMigrationCancelDialog
          agentId={agent.id}
          notice={currentAgentMigrationNotice}
          machines={machines}
          onClose={() => setShowMigrationCancel(false)}
          onRefresh={refreshMigrationStatus}
        />
      )}

      {canControlAgentRuntime && showStopConfirm && (
        <ConfirmDialog
          title={formatMessage({ id: "agent.detail.stopAgent" })}
          message={formatMessage(
            { id: "agent.detail.stopAgentConfirmMessage" },
            { name: agent.displayName || agent.name },
          )}
          confirmLabel={formatMessage({ id: "agent.detail.stopAgent" })}
          loadingLabel={formatMessage({ id: "agent.detail.stopping" })}
          confirmColor="bg-brutal-orange"
          chromeLocale="active"
          onConfirm={handleStop}
          onClose={() => setShowStopConfirm(false)}
        />
      )}

      {canManageAgent && showDeleteConfirm && (
        <ConfirmDialog
          title={formatMessage({ id: "agent.detail.deleteAgent" })}
          message={isExternalAgent
            ? formatMessage(
                { id: "agent.detail.deleteExternalAgentConfirmMessage" },
                { name: agent.displayName || agent.name },
              )
            : formatMessage(
                { id: "agent.detail.deleteAgentConfirmMessage" },
                { name: agent.displayName || agent.name },
              )}
          confirmLabel={formatMessage({ id: "agent.detail.deleteAgent" })}
          loadingLabel={formatMessage({ id: "agent.detail.deleting" })}
          chromeLocale="active"
          onConfirm={handleDelete}
          onClose={() => setShowDeleteConfirm(false)}
        />
      )}
    </div>
  );
}
