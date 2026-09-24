import { useState, useEffect, useMemo, useReducer, useRef } from "react";
import type { ChangeEvent, FormEvent, ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import {
  Settings,
  ChevronRight,
  Check,
  Copy,
  Plus,
  Bot,
  User,
  Users,
  Mail,
  Shield,
  Bell,
  Building2,
  Clock,
  Languages,
  X,
  CreditCard,
  AlertTriangle,
  Eye,
  Link2,
  ExternalLink,
  Trash2,
  LogOut,
  Upload,
  FileText,
  Tag,
  Type,
  Pencil,
  FlaskConical,
  LayoutGrid,
  List,
  Smartphone,
  Globe2,
  Hash,
} from "lucide-react";
import MobileDownloadQr from "./MobileDownloadQr";
import { MOBILE_DOWNLOAD_CHOOSER_PATH, mobileDownloadUrl } from "../../utils/mobileDownloadUrl";
import { getApiErrorResponse } from "../../utils/apiErrorResponse";
import {
  DEFAULT_BILLING_INTERVAL,
  PLAN_CONFIG,
  DOWNGRADE_GRACE_PERIOD_DAYS,
  FREE_MONTHLY_FILE_UPLOAD_LIMIT_BYTES,
  OAUTH_CLIENT_CATEGORIES,
  PRO_AGENT_SEAT_FRACTION,
  PRO_AGENT_SEAT_BLOCK_SIZE,
  PRO_SEAT_ANNUAL_USD,
  PRO_SEAT_MONTHLY_USD,
  PROVIDER_CONNECTIONS_FEATURE_FLAG_KEY,
  PUBLIC_SERVER_FEATURE_FLAG_KEY,
  SERVER_LABS_UI_FEATURE_FLAG_KEY,
  SLACK_BRIDGE_FEATURE_FLAG_KEYS,
  WIKI_FEATURE_FLAG_KEY,
  formatProAgentSeatFraction,
  getEffectiveLimits,
  getFinitePlanLimitExcess,
  isTrialActive,
  renderThirdPartyInertText,
} from "@botiverse/raft-shared";
import type {
  BillingInterval,
  OAuthClientCategory,
  ServerPlan,
  ServerRole,
  TimeFormatPreference,
} from "@botiverse/raft-shared";
import { useAuthStore } from "../../store/authStore";
import { useServerStore } from "../../store/serverStore";
import {
  SERVER_NOTIFICATION_PREFS_UPDATED_EVENT,
} from "../../store/events/notificationPrefsEvents";
import type {
  ServerNotificationPrefsUpdatedDetail,
} from "../../store/events/notificationPrefsEvents";
import { useAgentStore } from "../../store/agentStore";
import { requestServerSelection } from "../../utils/serverSelectionRequest";
import { useMobileBack } from "../../hooks/useAppNavigate";
import { useServerPermissions } from "../../hooks/useServerPermissions";
import { useTimeFormatter } from "../../hooks/useTimeFormatter";
import ConfirmDialog from "../ConfirmDialog";
import Modal from "../Modal";
import Banner from "../ui/Banner";
import api from "../../api/client";
import { useIntl } from "react-intl";
import type { IntlShape } from "react-intl";
import type { MessageId } from "../../i18n/messages";
import { useLocale } from "../../i18n/LocaleProvider";
import { SUPPORTED_LOCALES, LOCALE_LABELS } from "../../i18n/locale";
import type { Locale } from "../../i18n/locale";
import { persistDisplayLanguage } from "../../i18n/persistDisplayLanguage";
import { WEB_APP_VERSION } from "../../utils/webAppVersion";
import { bumpServerSetupRevision } from "../onboarding/serverSetupProjection";
import {
  disablePushNotifications,
  enablePushNotifications,
  getPushPermissionState,
  isPushServerConfigured,
  isPushSubscribed,
  sendTestPushNotification,
} from "../../utils/pushNotifications";
import Checkbox from "../ui/Checkbox";
import Textarea from "../ui/Textarea";
import { avatarUploadApiErrorMessage, isAvatarFileTooLarge, isAvatarTooLargeError, PROFILE_AVATAR_ACCEPT } from "../../utils/avatarUpload";
import PanelHeader from "../ui/PanelHeader";
import SectionEyebrow from "../ui/SectionEyebrow";
import SectionHeader from "../ui/SectionHeader";
import Button from "../ui/Button";
import CopyButton from "../ui/CopyButton";
import FormField from "../ui/FormField";
import AvatarSlot from "../ui/AvatarSlot";
import AvatarListRow from "../ui/AvatarListRow";
import SelectionPopover from "../ui/SelectionPopover";
import SurfaceListItem from "../ui/SurfaceListItem";
import SlugInput, { PrefixedInput } from "../ui/SlugInput";
import Skeleton from "../ui/Skeleton";
import {
  AGENT_INBOUND_NEGATIVE_CAPABILITY_ID,
  AGENT_INBOUND_OAUTH_SCOPES,
  DEFAULT_DECLARED_OAUTH_SCOPES,
  IDENTITY_OAUTH_SCOPES,
  OPTIONAL_IDENTITY_OAUTH_SCOPES,
  OAUTH_SCOPE_PRESENTATION,
  hasAgentInboundOAuthScope,
  normalizeDeclaredOAuthScopes,
  scopeGroupLabelId,
} from "../../lib/oauthScopePresentation";
import type {
  OAuthScopeTier,
  RaftOAuthScopeId,
} from "../../lib/oauthScopePresentation";
import MessageItem from "../message/MessageItem";
import type { MentionEntry } from "../message/MessageItem";
import { PwaInstallSettingsCard } from "../pwa/PwaInstallPrompt";
import ArchivedChannelsSection from "./ArchivedChannelsSection";
import IMBridgesSettingsSection from "./IMBridgesSettingsSection";
import { isSlackBridgeSurfaceEnabled } from "./slackBridgeVisibility";
import { useAuthProviders } from "../../hooks/useAuthProviders";
import type { AuthProvider } from "../../hooks/useAuthProviders";
import type { SocialAuthProviderId } from "../../hooks/useAuthProviders";
import type { Message } from "../../store/messageStore";
import type { Agent } from "../../store/agentStore";
import { useChannelStore } from "../../store/channelStore";
import type { Channel } from "../../store/channelStore";
import {
  canRemoveAdminPrincipal,
  getAdminCandidatePrincipals,
  getAdminPrincipalKey,
  getAdminPrincipalLabel,
  getAdminPrincipalRoleOptions,
  getAdminPrincipals,
  getMemberLabel,
} from "../../utils/serverAdminSettings";
import type {
  ServerAdminSettingsPrincipal,
} from "../../utils/serverAdminSettings";
import {
  createServerLabEnrollmentMutation,
  createServerLabMasterMutation,
  getServerLabDescriptionMessageId,
  getServerLabEnrollmentDisabledReasonMessageId,
  getServerLabSettingsAuthority,
  isServerLabEnrollmentEditable,
  normalizeServerLabSettingsReadback,
} from "../../utils/serverLabsSettings";
import type {
  CanonicalServerLabSettingsReadback,
  ServerLabSettingsReadback,
} from "../../utils/serverLabsSettings";
import { refreshServerFeatureFlags, useServerFeatureFlag } from "../../store/serverFeatureFlags";
import {
  beginServerLabsMutation,
  createServerLabsStoreContext,
  failServerLabsMutation,
  loadServerLabsSettings,
  publishServerLabsReadback,
  useServerLabsSettingsSnapshot,
} from "../../store/serverLabsSettingsStore";
import type {
  ServerLabsStoreContext,
} from "../../store/serverLabsSettingsStore";
import { getBillingControlsState, getSettingsBillingPlanPresentation } from "../../utils/billingControls";
import { formatGlobalTrialCutoffDate } from "../../utils/trialCutoff";
import {
  applyBillingSeatInputChange,
  applyBillingSeatInputCommit,
  getBillingSeatDraftState,
  getBillingCurrentTotalLabel,
  getBillingSeatCopyLabels,
  getBillingSeatInputValue,
  getBillingSelectedTotalLabels,
  getBillingTotalSummaryLabels,
} from "../../utils/billingSeatInput";
import type {
  BillingPricedTotal,
} from "../../utils/billingSeatInput";
import { getTimezoneOptions, getTranslationLanguageOptions, useTranslationStore } from "../../store/translationStore";
import type { PreferredTranslationMode } from "../../store/translationStore";
import AgreementBody from "../server/AgreementBody";
import { AppleLogo, GitHubLogo, GoogleLogo } from "../icons/ProviderLogos";
import {
  useAppearanceStore,
} from "../../store/appearanceStore";
import { useWorkspaceGridAvailability } from "../workspace/workspaceGridAvailability";
import { useWorkspaceGridNavigationStore } from "../workspace/workspaceGridNavigationStore";
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
  SegmentedControlItem,
  SegmentedControlLabel,
  Switch,
} from "raft-ui";
import {
  BillingIntervalSegmentedControl,
  ConnectedAppsTabSegmentedControl,
  MessageBodyFontSizeSegmentedControl,
} from "./SettingsSegmentedControls";
import type {
  ConnectedAppsTab,
} from "./SettingsSegmentedControls";
import {
  SETTINGS_ICON_BY_ID,
  SETTINGS_TAB_TITLE_ID,
  canOpenSettingsTab,
  normalizeSettingsTab,
} from "./settingsNavigation";
import {
  ConnectedAppsErrorBanner,
  CONNECTED_APPS_ERROR_FORM,
  CONNECTED_APPS_ERROR_LISTING,
  CONNECTED_APPS_ERROR_PAGE,
  getConnectedAppsErrorSurface,
} from "./connectedAppsErrorSurface";
import SettingsProfileCard from "./SettingsProfileCard";
import { LazyAboutFeedbackPanel } from "./LazyAboutFeedbackDialog";
import { AgentMcpTab } from "../agent/AgentMcpTab";
import ProviderConnectionsSettings from "./ProviderConnectionsSettings";
import WikiSettingsSection from "./WikiSettingsSection";
import {
  AppNotificationRequestSummary,
  DeveloperAppNotifications,
  InstalledAppNotifications,
} from "./AppNotificationsControls";
import type {
  AppNotificationSelection,
  AppNotificationsDeveloperState,
} from "./AppNotificationsControls";

type SelectOption = {
  value: string;
  label: string;
  disabled?: boolean;
};

function getSelectMenuOptions(
  options: readonly SelectOption[],
  value: string,
  {
    hideSelectedOption = false,
    hiddenOptionValues = [],
  }: {
    hideSelectedOption?: boolean;
    hiddenOptionValues?: readonly string[];
  } = {},
) {
  const hiddenValues = new Set(hiddenOptionValues);
  return options.filter((option) => {
    if (hiddenValues.has(option.value)) return false;
    return !(hideSelectedOption && option.value === value);
  });
}

function renderSelectItems(options: readonly SelectOption[]) {
  return options.map((option) => (
    <SelectItem key={option.value} value={option.value} disabled={option.disabled}>
      <SelectItemText>{option.label}</SelectItemText>
      <SelectItemIndicator />
    </SelectItem>
  ));
}

const APPEARANCE_PREVIEW_AGENT: Agent = {
  id: "appearance-preview-agent",
  name: "cindy-preview",
  displayName: "Cindy",
  avatarUrl: "pixel:random:cindy-preview",
  description: null,
  status: "active",
  model: "preview",
  runtime: "preview",
  serverRole: null,
  reasoningEffort: null,
  executionMode: "cloud",
  envVars: null,
  machineId: null,
  runtimeProfile: null,
  creatorType: null,
  creatorId: null,
  creator: null,
  createdAgents: [],
  deletedAt: null,
  createdAt: "2026-05-19T00:00:00.000Z",
};

const APPEARANCE_PREVIEW_CHANNEL: Channel = {
  id: "appearance-preview-channel",
  name: "proj-uiux",
  description: null,
  type: "channel",
  createdAt: "2026-05-19T00:00:00.000Z",
};

const APPEARANCE_PREVIEW_MENTION_MAP = new Map<string, MentionEntry>([
  ["joy", { displayName: "Joy", type: "user", id: "appearance-preview-joy" }],
]);

const PRE_JOIN_AGREEMENT_BODY_MAX_LENGTH = 5_000;
const PRE_JOIN_AGREEMENT_BODY_MAX_LENGTH_LABEL = "5,000";

// ── Account Section ──


function SocialProviderIcon({ providerId }: { providerId: SocialAuthProviderId }) {
  if (providerId === "google") {
    return (
      <span className="inline-flex size-[18px] shrink-0 items-center justify-center">
        <GoogleLogo className="size-4" />
      </span>
    );
  }
  if (providerId === "apple") {
    return (
      <span className="inline-flex size-[18px] shrink-0 items-center justify-center text-black">
        <AppleLogo className="size-4" />
      </span>
    );
  }
  return (
    <span className="inline-flex size-[18px] shrink-0 items-center justify-center text-black">
      <GitHubLogo className="size-4" />
    </span>
  );
}

// Exported for the sub-batch-A i18n DOM smoke test: renders the Account section
// in isolation without SettingsPanel's account-tab WorkspaceModeSettingsCard,
// which reads the Vite-only `import.meta.env` graph the node harness cannot shim.
export function AccountSection({
  initialError,
  passwordChangeIntent = false,
}: {
  initialError?: string;
  passwordChangeIntent?: boolean;
} = {}) {
  const { formatMessage } = useIntl();
  const user = useAuthStore((s) => s.user);
  const updateProfile = useAuthStore((s) => s.updateProfile);
  const uploadAvatar = useAuthStore((s) => s.uploadAvatar);
  const { providers } = useAuthProviders();

  const [displayName, setDisplayName] = useState(user?.displayName || "");
  const [savedDisplayName, setSavedDisplayName] = useState(user?.displayName || "");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState(initialError ?? "");
  const [linkedIdentities, setLinkedIdentities] = useState<Record<string, { providerEmail: string | null }>>({});
  const [passwordConfigured, setPasswordConfigured] = useState<boolean | null>(null);
  const [linkingProviderId, setLinkingProviderId] = useState<SocialAuthProviderId | null>(null);
  const [pendingDisconnectProvider, setPendingDisconnectProvider] = useState<AuthProvider | null>(null);
  const [passwordSetupLoading, setPasswordSetupLoading] = useState(false);
  const [passwordSetupError, setPasswordSetupError] = useState("");
  const [passwordSetupEmailSent, setPasswordSetupEmailSent] = useState(false);
  const [passwordSetupSentForProvider, setPasswordSetupSentForProvider] = useState<AuthProvider | null>(null);
  const [avatarSaving, setAvatarSaving] = useState(false);
  const [avatarError, setAvatarError] = useState("");

  // Password change
  const [showPasswordChange, setShowPasswordChange] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [passwordSaved, setPasswordSaved] = useState(false);

  // User-scoped form re-sync (NOT server-scoped, so the future
  // SettingsPanel key-remount-by-server follow-up doesn't cover this).
  // Same FP family as Cluster 2/3 form-reset effects.
  // oxlint-disable-next-line react-doctor/no-cascading-set-state
  useEffect(() => {
    const nextDisplayName = user?.displayName || "";
    // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change
    setDisplayName(nextDisplayName);
    // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change
    setSavedDisplayName(nextDisplayName);
    // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change
    setSaved(false);
  }, [user?.id, user?.displayName]);

  useEffect(() => {
    let cancelled = false;

    async function loadIdentities() {
      try {
        const { data } = await api.get("/auth/identities");
        if (cancelled) return;
        const next: Record<string, { providerEmail: string | null }> = {};
        for (const identity of data.identities ?? []) {
          if (identity?.provider) {
            next[identity.provider] = { providerEmail: identity.providerEmail ?? null };
          }
        }
        setLinkedIdentities(next);
        setPasswordConfigured(data.passwordConfigured === true);
      } catch {
        if (!cancelled) {
          setLinkedIdentities({});
          setPasswordConfigured(null);
        }
      }
    }

    void loadIdentities();

    return () => {
      cancelled = true;
    };
  }, [user?.id]);

  const visibleProviders = useMemo(
    () => providers.filter((provider) => provider.enabled || !!linkedIdentities[provider.id]),
    [linkedIdentities, providers],
  );
  const linkedProviderLabels = visibleProviders
    .filter((provider) => !!linkedIdentities[provider.id])
    .map((provider) => provider.label)
    .join(", ");
  const linkedIdentityCount = Object.keys(linkedIdentities).length;
  const passwordFormOpen = passwordChangeIntent || showPasswordChange;
  const pendingDisconnectRequiresPassword = !!pendingDisconnectProvider
    && linkedIdentityCount === 1
    && passwordConfigured === false;

  const applyAuthMethods = (data: {
    identities?: Array<{ provider?: string; providerEmail?: string | null }>;
    passwordConfigured?: boolean;
  }) => {
    const next: Record<string, { providerEmail: string | null }> = {};
    for (const identity of data.identities ?? []) {
      if (identity.provider) {
        next[identity.provider] = { providerEmail: identity.providerEmail ?? null };
      }
    }
    setLinkedIdentities(next);
    setPasswordConfigured(data.passwordConfigured === true);
  };

  const handleConnectProvider = async (provider: AuthProvider) => {
    setError("");
    setLinkingProviderId(provider.id);
    try {
      const { data } = await api.post(`/auth/${provider.id}/link/start`, {
        returnTo: `${window.location.pathname}${window.location.search}`,
      });
      window.location.href = data.url;
    } catch (err: any) {
      setError(err.response?.data?.error || formatMessage({ id: "settings.account.failedConnectProvider" }, { label: provider.label }));
      setLinkingProviderId(null);
    }
  };

  const handleDisconnectProvider = async (provider: AuthProvider) => {
    try {
      const { data } = await api.delete(`/auth/identities/${provider.id}`);
      applyAuthMethods(data);
      setPendingDisconnectProvider(null);
    } catch (err: unknown) {
      const axiosError = err as { response?: { data?: { code?: string } } };
      if (axiosError.response?.data?.code === "PASSWORD_CREDENTIAL_REQUIRED") {
        try {
          const { data } = await api.get("/auth/identities");
          applyAuthMethods(data);
        } catch {
          setPasswordConfigured(false);
        }
      }
      throw err;
    }
  };

  const handleSendPasswordSetup = async (provider?: AuthProvider) => {
    setPasswordSetupError("");
    setPasswordSetupLoading(true);
    try {
      await api.post("/auth/forgot-password", { email: user?.email });
      setPasswordSetupEmailSent(true);
      setPasswordSetupSentForProvider(provider ?? null);
      setPendingDisconnectProvider(null);
    } catch (err: unknown) {
      const axiosError = err as { response?: { data?: { error?: string } } };
      setPasswordSetupError(axiosError.response?.data?.error || formatMessage({ id: "settings.account.failedSendPasswordSetup" }));
      if (provider) throw err;
    } finally {
      setPasswordSetupLoading(false);
    }
  };

  const handleSaveProfile = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setSaving(true);
    setSaved(false);
    try {
      await updateProfile({ displayName });
      setSavedDisplayName(displayName);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err: any) {
      setError(err.response?.data?.error || formatMessage({ id: "settings.account.failedUpdateProfile" }));
    } finally {
      setSaving(false);
    }
  };

  const profileDirty = displayName !== savedDisplayName;

  const handleUploadAvatar = async (file: File) => {
    if (isAvatarFileTooLarge(file)) {
      setAvatarError(formatMessage({ id: "avatar.tooLarge" }, { maxLabel: formatMessage({ id: "common.fileSize.maxLabel5mb" }) }));
      return;
    }
    setAvatarError("");
    setAvatarSaving(true);
    try {
      await uploadAvatar(file);
    } catch (err: any) {
      setAvatarError(isAvatarTooLargeError(err)
        ? formatMessage({ id: "avatar.tooLarge" }, { maxLabel: formatMessage({ id: "common.fileSize.maxLabel5mb" }) })
        : avatarUploadApiErrorMessage(err, formatMessage({ id: "settings.account.failedUploadAvatar" })));
    } finally {
      setAvatarSaving(false);
    }
  };

  const handleChangePassword = async (e: FormEvent) => {
    e.preventDefault();
    setPasswordError("");

    if (newPassword.length < 8) {
      setPasswordError(formatMessage({ id: "settings.account.newPasswordTooShort" }));
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordError(formatMessage({ id: "settings.account.passwordsDoNotMatch" }));
      return;
    }

    setSaving(true);
    setPasswordSaved(false);
    try {
      await updateProfile({ currentPassword, newPassword });
      setPasswordSaved(true);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setTimeout(() => setPasswordSaved(false), 2000);
    } catch (err: any) {
      setPasswordError(err.response?.data?.error || formatMessage({ id: "settings.account.failedChangePassword" }));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className="mb-6">
        <SectionHeader
          className="mb-3"
          icon={<User size={16} />}
          label={formatMessage({ id: "settings.account.sectionLabel" })}
        />

        <SettingsProfileCard
          testId="account-profile-card"
          title={user?.displayName || user?.name || formatMessage({ id: "settings.account.sectionLabel" })}
          subtitle={user?.name ? `@${user.name}` : ""}
          avatar={
            <label
              className={`group relative flex size-16 shrink-0 items-center justify-center ${
                avatarSaving ? "cursor-not-allowed opacity-70" : ""
              }`}
              title={avatarSaving ? formatMessage({ id: "settings.common.uploadingAvatar" }) : formatMessage({ id: "settings.common.uploadImage" })}
              aria-label={avatarSaving ? formatMessage({ id: "settings.common.uploadingAvatar" }) : formatMessage({ id: "settings.common.uploadImage" })}
            >
              <AvatarSlot context="profile-tile" type="human" humanAvatarUrl={user?.avatarUrl} email={user?.email} />
              <div className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 transition-opacity group-hover:opacity-100">
                <Upload size={18} className="text-white" />
              </div>
              <input
                type="file"
                accept={PROFILE_AVATAR_ACCEPT}
                className="hidden"
                disabled={avatarSaving}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.currentTarget.value = "";
                  if (file) void handleUploadAvatar(file);
                }}
              />
            </label>
          }
        >
          {avatarError ? (
            <p className="text-xs font-bold text-brutal-red" role="alert">{avatarError}</p>
          ) : null}
          {/* Profile form */}
          <form onSubmit={handleSaveProfile} className="space-y-3">
          <FormField label={formatMessage({ id: "settings.account.displayNameLabel" })} labelStyle="plain" size="compact">
            <input
              data-testid="account-profile-display-name-input"
              type="text"
              value={displayName}
              onChange={(e) => {
                setDisplayName(e.target.value);
                setSaved(false);
              }}
              className="w-full border-2 border-black p-2 text-sm shadow-brutal-sm focus:shadow-brutal focus:outline-none"
            />
          </FormField>
          <FormField label={formatMessage({ id: "settings.account.usernameLabel" })} labelStyle="plain" size="compact">
            <PrefixedInput
              data-testid="account-profile-username-input"
              type="text"
              value={user?.name ?? ""}
              readOnly
              aria-readonly="true"
              tabIndex={-1}
              prefix="@"
              className="border-black/30 bg-gray-50 shadow-none focus-within:shadow-none"
              inputClassName="cursor-default text-sm text-black/60"
            />
          </FormField>
          <FormField label={formatMessage({ id: "settings.account.emailLabel" })} labelStyle="plain" size="compact">
            <div className="flex items-center gap-2">
              <span className="font-mono text-sm">{user?.email}</span>
              {user?.emailVerified ? (
                <span className="inline-flex items-center gap-1 border border-black bg-brutal-lime px-1.5 text-[10px] font-bold uppercase">
                  <Shield size={10} /> {formatMessage({ id: "settings.account.verified" })}
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 border border-black bg-brutal-orange/30 px-1.5 text-[10px] font-bold uppercase">
                  {formatMessage({ id: "settings.account.unverified" })}
                </span>
              )}
            </div>
          </FormField>

          {error && (
            <Banner intent="warning" density="sm" className="font-bold">{error}</Banner>
          )}

          <button
            type="submit"
            disabled={!profileDirty || saving}
            className="btn-brutal bg-brutal-pink px-3 py-1.5 text-xs flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving ? formatMessage({ id: "settings.common.saving" }) : saved ? (
              <><Check size={14} /> {formatMessage({ id: "settings.common.saved" })}</>
            ) : formatMessage({ id: "settings.account.saveProfile" })}
          </button>
          </form>

        {/* Divider */}
        <div className="border-t-2 border-black" />

        {visibleProviders.length > 0 && (
          <>
            <div>
              <div className="mb-2 text-sm font-bold">{formatMessage({ id: "settings.account.connectedAccounts" })}</div>
              <div className="space-y-2">
                {visibleProviders.map((provider) => {
                  const identity = linkedIdentities[provider.id];
                  return (
                    <div
                      key={provider.id}
                      role="group"
                      aria-label={formatMessage({ id: "settings.account.providerAccountAria" }, { label: provider.label })}
                      className="relative flex items-start justify-between gap-3 border-2 border-black/30 bg-white p-3 text-left transition-colors hover:border-black hover:shadow-brutal-sm"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="mb-1 flex items-center gap-2 text-xs">
                          <SocialProviderIcon providerId={provider.id} />
                          <span className="font-bold text-black">{provider.label}</span>
                        </div>
                        <div className="truncate text-xs text-black/50">
                          {identity?.providerEmail
                            ? formatMessage({ id: "settings.account.connectedAs" }, { email: identity.providerEmail })
                            : formatMessage({ id: "settings.account.notConnected" })}
                        </div>
                      </div>
                      {!identity && (
                        <button
                          type="button"
                          onClick={() => handleConnectProvider(provider)}
                          disabled={linkingProviderId === provider.id}
                          className="btn-brutal-sm shrink-0 bg-white px-3 py-1.5 text-xs disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {linkingProviderId === provider.id ? formatMessage({ id: "settings.account.connecting" }) : formatMessage({ id: "settings.account.connect" })}
                        </button>
                      )}
                      {identity && (
                        <button
                          type="button"
                          onClick={() => {
                            setPasswordSetupError("");
                            setPasswordSetupSentForProvider(null);
                            setPendingDisconnectProvider(provider);
                          }}
                          aria-label={formatMessage({ id: "settings.account.disconnectAria" }, { label: provider.label })}
                          className="btn-brutal-sm shrink-0 bg-white px-3 py-1.5 text-xs"
                        >
                          {formatMessage({ id: "settings.account.disconnect" })}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
              {passwordSetupSentForProvider && (
                <Banner intent="success" density="sm" className="mt-3 font-bold">
                  {formatMessage(
                    { id: "settings.account.passwordSetupSentForProvider" },
                    { label: passwordSetupSentForProvider.label },
                  )}
                </Banner>
              )}
            </div>

            <div className="border-t-2 border-black" />
          </>
        )}

        {/* Password credential */}
        <div>
          {passwordChangeIntent && passwordConfigured === null ? (
            <p className="text-xs text-black/60" role="status">
              {formatMessage({ id: "settings.account.loadingSignInMethods" })}
            </p>
          ) : passwordChangeIntent && passwordConfigured === false ? (
            <div className="space-y-2" data-testid="password-managed-by-provider">
              <div className="text-sm font-bold">
                {formatMessage({ id: "settings.account.passwordManagedTitle" })}
              </div>
              <p className="text-xs text-black/60">
                {formatMessage(
                  { id: "settings.account.passwordManagedDescription" },
                  {
                    providers: linkedProviderLabels
                      || formatMessage({ id: "settings.account.connectedSignInProvider" }),
                  },
                )}
              </p>
            </div>
          ) : passwordConfigured === false ? (
            <div className="space-y-3">
              <div>
                <div className="text-sm font-bold">{formatMessage({ id: "settings.account.setPassword" })}</div>
                <p className="mt-1 text-xs text-black/60">
                  {formatMessage({ id: "settings.account.setPasswordDescription" })}
                </p>
              </div>
              {passwordSetupError && (
                <Banner intent="warning" density="sm" className="font-bold">{passwordSetupError}</Banner>
              )}
              {passwordSetupEmailSent && !passwordSetupSentForProvider && (
                <Banner intent="success" density="sm" className="font-bold">
                  {formatMessage({ id: "settings.account.passwordSetupEmailSent" })}
                </Banner>
              )}
              <button
                type="button"
                onClick={() => void handleSendPasswordSetup()}
                disabled={passwordSetupLoading}
                className="btn-brutal bg-brutal-pink px-3 py-1.5 text-xs disabled:cursor-not-allowed disabled:opacity-50"
              >
                {passwordSetupLoading
                  ? formatMessage({ id: "settings.account.sendingSetupEmail" })
                  : formatMessage({ id: "settings.account.setPasswordByEmail" })}
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setShowPasswordChange(!showPasswordChange)}
              className="flex items-center gap-2 text-sm font-bold"
            >
              <ChevronRight
                size={14}
                className={`transition-transform ${passwordFormOpen ? "rotate-90" : ""}`}
              />
              {formatMessage({ id: "settings.account.changePassword" })}
            </button>
          )}

          {(!passwordChangeIntent || passwordConfigured === true) && passwordFormOpen && (
            <form onSubmit={handleChangePassword} className="mt-3 space-y-3">
              <FormField label={formatMessage({ id: "settings.account.currentPassword" })} labelStyle="plain" size="compact">
                <input
                  type="password"
                  name="current-password"
                  autoComplete="current-password"
                  aria-label={formatMessage({ id: "settings.account.currentPassword" })}
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  className="w-full border-2 border-black p-2 text-sm shadow-brutal-sm focus:shadow-brutal focus:outline-none"
                  required
                />
              </FormField>
              <FormField label={formatMessage({ id: "settings.account.newPassword" })} labelStyle="plain" size="compact">
                <input
                  type="password"
                  name="new-password"
                  autoComplete="new-password"
                  aria-label={formatMessage({ id: "settings.account.newPassword" })}
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  className="w-full border-2 border-black p-2 text-sm shadow-brutal-sm focus:shadow-brutal focus:outline-none"
                  placeholder={formatMessage({ id: "settings.account.minCharsPlaceholder" })}
                  required
                />
              </FormField>
              <FormField label={formatMessage({ id: "settings.account.confirmPassword" })} labelStyle="plain" size="compact">
                <input
                  type="password"
                  name="confirm-password"
                  autoComplete="new-password"
                  aria-label={formatMessage({ id: "settings.account.confirmPassword" })}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className="w-full border-2 border-black p-2 text-sm shadow-brutal-sm focus:shadow-brutal focus:outline-none"
                  required
                />
              </FormField>

              {passwordError && (
                <Banner intent="warning" density="sm" className="font-bold">{passwordError}</Banner>
              )}

              {passwordSaved && (
                <div className="border-2 border-black bg-brutal-lime/30 p-2 text-xs font-bold">{formatMessage({ id: "settings.account.passwordUpdated" })}</div>
              )}

              <button
                type="submit"
                disabled={saving}
                className="btn-brutal bg-brutal-pink px-3 py-1.5 text-xs"
              >
                {saving ? formatMessage({ id: "settings.account.updating" }) : formatMessage({ id: "settings.account.changePassword" })}
              </button>
            </form>
          )}
        </div>
        </SettingsProfileCard>
      </div>

      {pendingDisconnectProvider && (
        <ConfirmDialog
          title={formatMessage(
            {
              id: pendingDisconnectRequiresPassword
                ? "settings.account.passwordRequiredTitle"
                : "settings.account.disconnectTitle",
            },
            { label: pendingDisconnectProvider.label },
          )}
          message={formatMessage(
            {
              id: pendingDisconnectRequiresPassword
                ? "settings.account.passwordRequiredMessage"
                : "settings.account.disconnectMessage",
            },
            { label: pendingDisconnectProvider.label },
          )}
          confirmLabel={formatMessage({
            id: pendingDisconnectRequiresPassword
              ? "settings.account.sendSetupEmail"
              : "settings.account.disconnect",
          })}
          loadingLabel={formatMessage({
            id: pendingDisconnectRequiresPassword
              ? "settings.account.sendingSetupEmail"
              : "settings.account.disconnecting",
          })}
          confirmColor={pendingDisconnectRequiresPassword
            ? "bg-brutal-pink"
            : undefined}
          chromeLocale="active"
          onConfirm={() => pendingDisconnectRequiresPassword
            ? handleSendPasswordSetup(pendingDisconnectProvider)
            : handleDisconnectProvider(pendingDisconnectProvider)}
          onClose={() => setPendingDisconnectProvider(null)}
        />
      )}

      {/* Log out — sibling section so it gets its own mb-6 spacing and
          renders at the same indent level as Account / Browser / Server. */}
      <AccountSignOutSection />
    </>
  );
}

function AccountSignOutSection() {
  const { formatMessage } = useIntl();
  const logout = useAuthStore((s) => s.logout);
  const [showConfirm, setShowConfirm] = useState(false);

  return (
    <div className="mb-6">
      <SectionHeader
        className="mb-3"
        icon={<LogOut size={16} />}
        label={formatMessage({ id: "settings.session.sectionLabel" })}
      />

      <div className="border-2 border-black bg-white shadow-brutal-sm p-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-bold text-black">
              {formatMessage({ id: "settings.session.logOutTitle" })}
            </div>
            <p className="text-xs text-black/60 mt-0.5">
              {formatMessage({ id: "settings.session.logOutDescription" })}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setShowConfirm(true)}
            data-testid="account-logout"
            className="btn-brutal bg-brutal-orange px-4 py-2 [@media(max-height:600px)]:py-1 text-sm font-bold flex items-center gap-1.5 shrink-0 ml-4"
          >
            {formatMessage({ id: "settings.session.logOutAction" })}
          </button>
        </div>
      </div>

      {showConfirm && (
        <ConfirmDialog
          title={formatMessage({ id: "settings.session.confirmTitle" })}
          message={formatMessage({ id: "settings.session.confirmMessage" })}
          confirmLabel={formatMessage({ id: "settings.session.confirmLabel" })}
          loadingLabel={formatMessage({ id: "settings.session.confirmLoadingLabel" })}
          confirmColor="bg-brutal-orange"
          confirmTestId="account-logout-confirm-button"
          onConfirm={() => { logout(); }}
          onClose={() => setShowConfirm(false)}
        />
      )}
    </div>
  );
}

function NotificationsTabContent() {
  return (
    <>
      <PwaInstallSettingsCard />
      <NotificationsSection />
    </>
  );
}

function LanguageRegionSection() {
  const currentServer = useServerStore((s) => s.current);
  const settings = useTranslationStore((s) => s.settings);
  const settingsLoading = useTranslationStore((s) => s.settingsLoading);
  const settingsError = useTranslationStore((s) => s.settingsError);
  const loadSettings = useTranslationStore((s) => s.loadSettings);
  const updatePreferredLanguage = useTranslationStore((s) => s.updatePreferredLanguage);
  const updatePreferredTimezone = useTranslationStore((s) => s.updatePreferredTimezone);
  const updatePreferredTranslationMode = useTranslationStore((s) => s.updatePreferredTranslationMode);
  const updatePreferredTranslationDisplay = useTranslationStore((s) => s.updatePreferredTranslationDisplay);
  const updatePreferredTimeFormat = useTranslationStore((s) => s.updatePreferredTimeFormat);
  const [savingLanguageRegion, setSavingLanguageRegion] = useState(false);
  const [savingDateTime, setSavingDateTime] = useState(false);
  const [languageError, setLanguageError] = useState("");
  const [timezoneError, setTimezoneError] = useState("");
  const [translationDisplayError, setTranslationDisplayError] = useState("");
  const [timeFormatError, setTimeFormatError] = useState("");
  const savedTranslationTarget = settings.preferredLanguage ?? "browser";
  const savedTranslationMode = settings.preferredTranslationMode;
  const savedTimezone = settings.preferredTimezone ?? "";
  const savedTimeFormat = settings.effectiveTimeFormat === "24h" ? "24h" : "12h";
  const [translationTarget, setTranslationTarget] = useState(savedTranslationTarget);
  const [translationMode, setTranslationMode] = useState<PreferredTranslationMode>(savedTranslationMode);
  const [translationDisplay, setTranslationDisplay] = useState(settings.preferredTranslationDisplay);
  const [timezone, setTimezone] = useState(savedTimezone);
  const [timeFormat, setTimeFormat] = useState<"12h" | "24h">(savedTimeFormat);
  const [languageRegionSaved, setLanguageRegionSaved] = useState(false);
  const [dateTimeSaved, setDateTimeSaved] = useState(false);

  // UI display language (app-chrome i18n) — distinct from the translation
  // target above. `locale` is the live client locale; `displayLanguage` is the
  // form draft and must not trigger the app-wide locale swap until Save.
  const { formatMessage } = useIntl();
  const { locale, setLocale } = useLocale();
  const [displayLanguage, setDisplayLanguage] = useState<Locale>(locale);
  const displayLanguageOptions = useMemo(
    () => SUPPORTED_LOCALES.map((code) => ({ value: code, label: LOCALE_LABELS[code] })),
    [],
  );

  useEffect(() => {
    void loadSettings(currentServer?.id);
  }, [currentServer?.id, loadSettings]);

  // oxlint-disable-next-line react-doctor/no-derived-state-effect
  useEffect(() => {
    // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change
    setDisplayLanguage(locale);
  }, [locale]);

  // Language/region and date-time form state re-sync from `saved*` props when
  // the active server changes (`currentServer?.id` in deps). This re-sync is
  // INTENTIONAL on server-switch: opening the same Settings panel under a
  // different server should reflect that server's saved values, not the
  // previous server's. The seed-once guard from PR #2532 would be wrong here
  // (it would break the server-switch re-sync).
  //
  // The mid-server "clobber" risk (user editing while saved value changes
  // externally) is theoretically present but practically near-zero —
  // savedLanguage/savedTimezone are per-user personal settings, not
  // socket-pushed multi-actor state (unlike AddMembersDialog's `members`).
  //
  // The proper React-idiomatic fix is `<SettingsPanel key={currentServer.id}>`
  // (key-remount-by-server, same pattern as HumanDetailPanel in PR #2527) to
  // remove `currentServer?.id` from these deps; tracked as a follow-up.
  // For now inline-disable so @铁根 can flip no-derived-state-effect to error.
  // @铁根 plan verdict: msg=6551077c (no-derived-state-effect disable per PR #2539).
  // Sister rules broadened for cluster-4 sweep — same FP shape.
  // oxlint-disable-next-line react-doctor/no-derived-state-effect, react-doctor/no-cascading-set-state
  useEffect(() => {
    // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change
    setTranslationTarget(savedTranslationTarget);
    // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change
    setTranslationMode(savedTranslationMode);
    // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change
    setTranslationDisplay(settings.preferredTranslationDisplay);
    // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change
    setLanguageRegionSaved(false);
  }, [currentServer?.id, savedTranslationTarget, savedTranslationMode, settings.preferredTranslationDisplay]);

  // oxlint-disable-next-line react-doctor/no-derived-state-effect, react-doctor/no-cascading-set-state
  useEffect(() => {
    // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change
    setTimezone(savedTimezone);
    // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change
    setTimeFormat(savedTimeFormat);
    // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change
    setDateTimeSaved(false);
  }, [currentServer?.id, savedTimezone, savedTimeFormat]);

  const languageOptions = useMemo(
    () => getTranslationLanguageOptions(settings.effectiveLanguage, formatMessage),
    [formatMessage, settings.effectiveLanguage],
  );
  const timezoneOptions = useMemo(
    () => getTimezoneOptions(settings.effectiveTimezone, formatMessage),
    [formatMessage, settings.effectiveTimezone],
  );
  const hiddenTimezoneOptionValues = useMemo(
    () => [
      "",
      ...(!settings.preferredTimezone && settings.effectiveTimezone ? [settings.effectiveTimezone] : []),
    ],
    [settings.effectiveTimezone, settings.preferredTimezone],
  );
  // Keep `items` as the full collection so the trigger can resolve the current
  // value label; filter only the popup rows to preserve the old menu behavior.
  const languageMenuOptions = getSelectMenuOptions(languageOptions, translationTarget, { hideSelectedOption: true });
  const timezoneMenuOptions = getSelectMenuOptions(timezoneOptions, timezone, {
    hideSelectedOption: true,
    hiddenOptionValues: hiddenTimezoneOptionValues,
  });

  const languageRegionDirty =
    displayLanguage !== locale
    || translationTarget !== savedTranslationTarget
    || translationMode !== savedTranslationMode
    || translationDisplay !== settings.preferredTranslationDisplay;
  const dateTimeDirty = timezone !== savedTimezone || timeFormat !== savedTimeFormat;

  const handleSaveLanguageRegion = async (event: FormEvent) => {
    event.preventDefault();
    if (!languageRegionDirty) return;
    setSavingLanguageRegion(true);
    setLanguageError("");
    setTranslationDisplayError("");
    setLanguageRegionSaved(false);
    try {
      if (translationMode !== savedTranslationMode) {
        await updatePreferredTranslationMode(translationMode);
      }
      if (translationTarget !== savedTranslationTarget) {
        await updatePreferredLanguage(translationTarget === "browser" ? null : translationTarget);
      }
      if (translationDisplay !== settings.preferredTranslationDisplay) {
        await updatePreferredTranslationDisplay(translationDisplay);
      }
      if (displayLanguage !== locale) {
        await persistDisplayLanguage(displayLanguage, setLocale);
      }
      setLanguageRegionSaved(true);
      window.setTimeout(() => setLanguageRegionSaved(false), 1500);
    } catch (err: any) {
      setLanguageError(err.response?.data?.error || formatMessage({ id: "settings.language.updateFailed" }));
    } finally {
      setSavingLanguageRegion(false);
    }
  };

  const handleSaveDateTime = async (event: FormEvent) => {
    event.preventDefault();
    if (!dateTimeDirty) return;
    setSavingDateTime(true);
    setTimezoneError("");
    setTimeFormatError("");
    setDateTimeSaved(false);
    try {
      if (timezone !== savedTimezone) {
        await updatePreferredTimezone(timezone || null);
      }
      if (timeFormat !== savedTimeFormat) {
        await updatePreferredTimeFormat(timeFormat as TimeFormatPreference);
      }
      setDateTimeSaved(true);
      window.setTimeout(() => setDateTimeSaved(false), 1500);
    } catch (err: any) {
      setTimezoneError(err.response?.data?.error || formatMessage({ id: "settings.dateTime.updateFailed" }));
    } finally {
      setSavingDateTime(false);
    }
  };

  if (!currentServer) return null;

  return (
    <>
      <div className="mb-6">
        <SectionHeader
          className="mb-3"
          icon={<Languages size={16} />}
          label={formatMessage({ id: "settings.language.sectionLabel" })}
        />

        <form onSubmit={handleSaveLanguageRegion} className="border-2 border-black bg-white shadow-brutal-sm p-4 space-y-4">
          <div className="space-y-3">
            <div>
              <div className="text-sm font-bold text-black">
                {formatMessage({ id: "settings.language.displayLanguageTitle" })}
              </div>
              <div className="text-xs text-black/60 mt-0.5">
                {formatMessage({ id: "settings.language.displayLanguageDescription" })}
              </div>
            </div>
            <Select
              value={displayLanguage}
              onValueChange={(next) => {
                if (next == null) return;
                setLanguageRegionSaved(false);
                setLanguageError("");
                setDisplayLanguage(next as Locale);
              }}
              disabled={savingLanguageRegion || settingsLoading}
              items={displayLanguageOptions}
            >
              <SelectTrigger className="w-full max-w-sm" data-testid="display-language-select">
                <SelectValue />
                <SelectIcon />
              </SelectTrigger>
              <SelectContent>
                <SelectList>
                  {renderSelectItems(displayLanguageOptions)}
                </SelectList>
              </SelectContent>
            </Select>
            {/* Rollout notice: Chinese ships namespace-by-namespace, so warn that
                some pages may still be English while zh-cn is active. en never
                shows this. Removed once all namespaces are migrated. */}
            {locale === "zh-cn" ? (
              <div className="text-xs text-black/60 mt-0.5" data-testid="zh-coverage-notice">
                {formatMessage({ id: "settings.language.zhCoverageNotice" })}
              </div>
            ) : null}
          </div>
          <div className="space-y-3">
            <div>
              <div className="text-sm font-bold text-black">{formatMessage({ id: "settings.language.translationMode" })}</div>
              <div className="text-xs text-black/60 mt-0.5">
                {formatMessage({ id: "settings.language.translationModeDesc" })}
              </div>
            </div>
            <SegmentedControl<PreferredTranslationMode>
              value={translationMode}
              aria-label={formatMessage({ id: "settings.language.translationModeAria" })}
              onValueChange={(next) => {
                setLanguageRegionSaved(false);
                setLanguageError("");
                setTranslationMode(next);
              }}
              disabled={savingLanguageRegion || settingsLoading}
            >
              <SegmentedControlItem value="auto" data-testid="translation-mode-auto">
                <SegmentedControlLabel>{formatMessage({ id: "settings.language.modeAuto" })}</SegmentedControlLabel>
              </SegmentedControlItem>
              <SegmentedControlItem value="manual" data-testid="translation-mode-manual">
                <SegmentedControlLabel>{formatMessage({ id: "settings.language.modeManual" })}</SegmentedControlLabel>
              </SegmentedControlItem>
              <SegmentedControlItem value="off" data-testid="translation-mode-off">
                <SegmentedControlLabel>{formatMessage({ id: "settings.language.modeOff" })}</SegmentedControlLabel>
              </SegmentedControlItem>
            </SegmentedControl>
          </div>

          {translationMode !== "off" ? (
            <div className="space-y-3">
              <div>
                <div className="text-sm font-bold text-black">{formatMessage({ id: "settings.language.translationTarget" })}</div>
                <div className="text-xs text-black/60 mt-0.5">
                  {formatMessage({ id: "settings.language.translationTargetDesc" }, { language: settings.effectiveLanguage?.toUpperCase() ?? "English" })}
                </div>
              </div>
              <Select
                value={translationTarget}
                onValueChange={(next) => {
                  if (next == null) return;
                  setLanguageRegionSaved(false);
                  setLanguageError("");
                  setTranslationTarget(next);
                }}
                disabled={savingLanguageRegion || settingsLoading}
                items={languageOptions}
              >
                <SelectTrigger className="w-full max-w-sm">
                  <SelectValue placeholder={formatMessage({ id: "settings.language.preferredLanguagePlaceholder" })} />
                  <SelectIcon />
                </SelectTrigger>
                <SelectContent>
                  <SelectList>
                    {renderSelectItems(languageMenuOptions)}
                  </SelectList>
                </SelectContent>
              </Select>
            </div>
          ) : null}

          {translationMode !== "off" ? (
            <div className="space-y-3">
              <div>
                <div className="text-sm font-bold text-black">{formatMessage({ id: "settings.language.defaultView" })}</div>
                <div className="text-xs text-black/60 mt-0.5">
                  {formatMessage({ id: "settings.language.defaultViewDesc" })}
                </div>
              </div>
              <SegmentedControl<"translated" | "original" | "bilingual">
                value={translationDisplay}
                aria-label={formatMessage({ id: "settings.language.defaultViewAria" })}
                onValueChange={(next) => {
                  setLanguageRegionSaved(false);
                  setTranslationDisplayError("");
                  setTranslationDisplay(next);
                }}
                disabled={savingLanguageRegion || settingsLoading}
              >
                <SegmentedControlItem value="translated" data-testid="translation-display-translated">
                  <SegmentedControlLabel>{formatMessage({ id: "settings.language.displayTranslated" })}</SegmentedControlLabel>
                </SegmentedControlItem>
                <SegmentedControlItem value="original" data-testid="translation-display-original">
                  <SegmentedControlLabel>{formatMessage({ id: "settings.language.displayOriginal" })}</SegmentedControlLabel>
                </SegmentedControlItem>
                <SegmentedControlItem value="bilingual" data-testid="translation-display-bilingual">
                  <SegmentedControlLabel>{formatMessage({ id: "settings.language.displayBilingual" })}</SegmentedControlLabel>
                </SegmentedControlItem>
              </SegmentedControl>
            </div>
          ) : null}

          {(settingsError || languageError || translationDisplayError) && (
            <Banner intent="warning" density="sm" className="font-bold">
              {translationDisplayError || languageError || settingsError}
            </Banner>
          )}
          <button
            type="submit"
            disabled={!languageRegionDirty || savingLanguageRegion || settingsLoading}
            className="btn-brutal bg-brutal-pink px-3 py-1.5 text-xs flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {savingLanguageRegion ? formatMessage({ id: "settings.common.saving" }) : languageRegionSaved ? (
              <><Check size={14} /> {formatMessage({ id: "settings.common.saved" })}</>
            ) : formatMessage({ id: "settings.common.save" })}
          </button>
        </form>
      </div>

      <div className="mb-6">
        <SectionHeader
          className="mb-3"
          icon={<Clock size={16} />}
          label={formatMessage({ id: "settings.dateTime.sectionLabel" })}
        />

        <form onSubmit={handleSaveDateTime} className="border-2 border-black bg-white shadow-brutal-sm p-4 space-y-4">
          <div className="space-y-3">
            <div>
              <div className="text-sm font-bold text-black">{formatMessage({ id: "settings.dateTime.timezone" })}</div>
              <div className="text-xs text-black/60 mt-0.5">
                {formatMessage({ id: "settings.dateTime.timezoneDesc" })}
              </div>
            </div>
            <Select
              value={timezone}
              onValueChange={(next) => {
                if (next == null) return;
                setDateTimeSaved(false);
                setTimezoneError("");
                setTimezone(next);
              }}
              disabled={savingDateTime || settingsLoading}
              items={timezoneOptions}
            >
              <SelectTrigger className="w-full max-w-sm">
                <SelectValue placeholder={formatMessage({ id: "settings.dateTime.timezonePlaceholder" })} />
                <SelectIcon />
              </SelectTrigger>
              <SelectContent>
                <SelectList>
                  {renderSelectItems(timezoneMenuOptions)}
                </SelectList>
              </SelectContent>
            </Select>
            <div>
              <div className="text-sm font-bold text-black">{formatMessage({ id: "settings.dateTime.timeFormat" })}</div>
              <div className="text-xs text-black/60 mt-0.5">
                {formatMessage({ id: "settings.dateTime.timeFormatDesc" })}
              </div>
            </div>
            <SegmentedControl<"12h" | "24h">
              value={timeFormat}
              aria-label={formatMessage({ id: "settings.dateTime.timeFormatAria" })}
              onValueChange={(next) => {
                setDateTimeSaved(false);
                setTimeFormatError("");
                setTimeFormat(next);
              }}
              disabled={savingDateTime || settingsLoading}
            >
              <SegmentedControlItem value="12h" data-testid="time-format-12h">
                <SegmentedControlLabel>{formatMessage({ id: "settings.dateTime.formatTwelveHour" })}</SegmentedControlLabel>
              </SegmentedControlItem>
              <SegmentedControlItem value="24h" data-testid="time-format-24h">
                <SegmentedControlLabel>{formatMessage({ id: "settings.dateTime.formatTwentyFourHour" })}</SegmentedControlLabel>
              </SegmentedControlItem>
            </SegmentedControl>
          </div>

          {(settingsError || timezoneError || timeFormatError) && (
            <Banner intent="warning" density="sm" className="font-bold">
              {timezoneError || timeFormatError || settingsError}
            </Banner>
          )}
          <button
            type="submit"
            disabled={!dateTimeDirty || savingDateTime || settingsLoading}
            className="btn-brutal bg-brutal-pink px-3 py-1.5 text-xs flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {savingDateTime ? formatMessage({ id: "settings.common.saving" }) : dateTimeSaved ? (
              <><Check size={14} /> {formatMessage({ id: "settings.common.saved" })}</>
            ) : formatMessage({ id: "settings.common.save" })}
          </button>
        </form>
      </div>
    </>
  );
}

function NotificationsSection() {
  const { formatMessage } = useIntl();
  const currentServer = useServerStore((s) => s.current);
  const currentServerId = currentServer?.id;
  const applyServerPatch = useServerStore((s) => s.applyServerPatch);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [muting, setMuting] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">("unsupported");
  const [serverConfigured, setServerConfigured] = useState(false);
  const [subscribed, setSubscribed] = useState(false);
  const [serverPushMuted, setServerPushMuted] = useState(false);
  const [savedServerPushMuted, setSavedServerPushMuted] = useState(false);
  const serverPrefsVersionRef = useRef(currentServer?.notificationPrefsVersion ?? -1);

  const refreshState = async () => {
    const serverId = currentServerId;
    setLoading(true);
    setPermission(getPushPermissionState());
    const [configured, currentSubscribed, notificationSettings] = await Promise.all([
      isPushServerConfigured(),
      isPushSubscribed(),
      serverId
        ? api.get(`/servers/${serverId}/notification-settings`).then((res) => res.data as { serverPushMuted: boolean; prefsVersion?: number }).catch(() => null)
        : Promise.resolve(null),
    ]);
    if (serverId !== useServerStore.getState().current?.id) return;
    setServerConfigured(configured);
    setSubscribed(currentSubscribed);
    if (notificationSettings && serverId) {
      const prefsVersion = typeof notificationSettings.prefsVersion === "number"
        && Number.isSafeInteger(notificationSettings.prefsVersion)
        && notificationSettings.prefsVersion >= 0
        ? notificationSettings.prefsVersion
        : undefined;
      if (prefsVersion !== undefined && prefsVersion < serverPrefsVersionRef.current) {
        setLoading(false);
        return;
      }
      if (prefsVersion !== undefined) serverPrefsVersionRef.current = prefsVersion;
      const nextServerPushMuted = !!notificationSettings.serverPushMuted;
      setServerPushMuted(nextServerPushMuted);
      setSavedServerPushMuted(nextServerPushMuted);
      applyServerPatch({
        id: serverId,
        serverPushMuted: nextServerPushMuted,
        ...(prefsVersion === undefined ? {} : { notificationPrefsVersion: prefsVersion }),
      });
    }
    setLoading(false);
  };

  // oxlint-disable react-hooks/exhaustive-deps -- refetch push/notification state only when the active server id changes; `refreshState` is recreated each render and closes over the current `currentServer`, so depending on it would loop every render.
  useEffect(() => {
    serverPrefsVersionRef.current = currentServer?.notificationPrefsVersion ?? -1;
    void refreshState();
  }, [currentServerId]);
  // oxlint-enable react-hooks/exhaustive-deps

  // oxlint-disable-next-line react-doctor/no-cascading-set-state -- Realtime server notification-pref updates must refresh the open settings form and clear stale save status together.
  useEffect(() => {
    const handleNotificationPrefsUpdated = (event: Event) => {
      const detail = (event as CustomEvent<ServerNotificationPrefsUpdatedDetail>).detail;
      if (!currentServerId || detail?.serverId !== currentServerId) return;
      if (detail.prefsVersion !== undefined && detail.prefsVersion < serverPrefsVersionRef.current) return;
      if (detail.prefsVersion !== undefined) serverPrefsVersionRef.current = detail.prefsVersion;
      setServerPushMuted(detail.serverPushMuted);
      setSavedServerPushMuted(detail.serverPushMuted);
      setMessage("");
      setError("");
    };
    window.addEventListener(SERVER_NOTIFICATION_PREFS_UPDATED_EVENT, handleNotificationPrefsUpdated);
    return () => {
      window.removeEventListener(SERVER_NOTIFICATION_PREFS_UPDATED_EVENT, handleNotificationPrefsUpdated);
    };
  }, [currentServerId]);

  const handleEnable = async () => {
    setBusy(true);
    setError("");
    setMessage("");
    const result = await enablePushNotifications();
    if (result === "unavailable") {
      setError(formatMessage({ id: "settings.notifications.errUnavailable" }));
    } else if (result === "denied") {
      setError(formatMessage({ id: "settings.notifications.errDenied" }));
    } else if (result === "error") {
      setError(formatMessage({ id: "settings.notifications.errEnableFailed" }));
    }
    await refreshState();
    setBusy(false);
  };

  const handleDisable = async () => {
    setBusy(true);
    setError("");
    setMessage("");
    const ok = await disablePushNotifications();
    if (!ok) {
      setError(formatMessage({ id: "settings.notifications.errDisableFailed" }));
    }
    await refreshState();
    setBusy(false);
  };

  const handleSendTest = async () => {
    setTesting(true);
    setError("");
    setMessage("");
    const result = await sendTestPushNotification();
    if (result === "ok") {
      setMessage(formatMessage({ id: "settings.notifications.testSent" }));
    } else if (result === "unavailable") {
      setError(formatMessage({ id: "settings.notifications.errUnavailable" }));
    } else if (result === "not_subscribed") {
      setError(formatMessage({ id: "settings.notifications.errNotSubscribed" }));
    } else if (result === "error") {
      setError(formatMessage({ id: "settings.notifications.errSendFailed" }));
    }
    await refreshState();
    setTesting(false);
  };

  const handleSaveServerMute = async (event: FormEvent) => {
    event.preventDefault();
    if (!currentServer) return;
    setMuting(true);
    setError("");
    setMessage("");
    try {
      const { data } = await api.patch(`/servers/${currentServer.id}/notification-settings`, {
        serverPushMuted,
      });
      const nextServerPushMuted = !!data.serverPushMuted;
      const prefsVersion = typeof data.prefsVersion === "number"
        && Number.isSafeInteger(data.prefsVersion)
        && data.prefsVersion >= 0
        ? data.prefsVersion
        : undefined;
      if (prefsVersion === undefined || prefsVersion >= serverPrefsVersionRef.current) {
        if (prefsVersion !== undefined) serverPrefsVersionRef.current = prefsVersion;
        setServerPushMuted(nextServerPushMuted);
        setSavedServerPushMuted(nextServerPushMuted);
        applyServerPatch({
          id: currentServer.id,
          serverPushMuted: nextServerPushMuted,
          ...(prefsVersion === undefined ? {} : { notificationPrefsVersion: prefsVersion }),
        });
        setMessage(nextServerPushMuted
          ? formatMessage({ id: "settings.notifications.muted" }, { serverName: currentServer.name })
          : formatMessage({ id: "settings.notifications.unmuted" }, { serverName: currentServer.name }));
      }
    } catch {
      setError(formatMessage({ id: "settings.notifications.errSaveMute" }));
    }
    setMuting(false);
  };

  const statusLabel = loading
    ? formatMessage({ id: "settings.notifications.statusChecking" })
    : permission === "unsupported"
      ? formatMessage({ id: "settings.notifications.statusUnsupported" })
      : !serverConfigured
        ? formatMessage({ id: "settings.notifications.statusUnavailable" })
        : subscribed
          ? formatMessage({ id: "settings.notifications.statusEnabled" })
          : permission === "granted"
            ? formatMessage({ id: "settings.notifications.statusReady" })
            : permission === "denied"
              ? formatMessage({ id: "settings.notifications.statusDenied" })
              : formatMessage({ id: "settings.notifications.statusDisabled" });

  return (
    <div>
      <SectionHeader
        className="mb-3"
        icon={<Bell size={16} />}
        label={formatMessage({ id: "settings.notifications.sectionLabel" })}
      />

      <div className="border-2 border-black bg-white shadow-brutal-sm p-4 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-sm font-bold text-black">{formatMessage({ id: "settings.notifications.mainTitle" })}</div>
            <div className="text-xs text-black/60 mt-0.5">
              {formatMessage({ id: "settings.notifications.mainDescription" })}
            </div>
          </div>
          <span className="inline-flex shrink-0 border-2 border-black bg-soft-signal px-2 py-1 text-[10px] font-bold uppercase">
            {statusLabel}
          </span>
        </div>

        {permission === "unsupported" && (
          <div className="text-xs text-black/60">
            {formatMessage({ id: "settings.notifications.unsupportedHint" })}
          </div>
        )}

        {permission !== "unsupported" && !serverConfigured && !loading && (
          <div className="text-xs text-black/60">
            {formatMessage({ id: "settings.notifications.notConfiguredHint" })}
          </div>
        )}

        {permission === "denied" && (
          <div className="text-xs text-black/60">
            {formatMessage({ id: "settings.notifications.deniedHint" })}
          </div>
        )}

        {error && (
          <Banner intent="warning" density="sm" className="font-bold">{error}</Banner>
        )}

        {message && (
          <div className="border-2 border-black bg-brutal-lime/30 p-2 text-xs font-bold">{message}</div>
        )}

        <div className="flex gap-2">
          {subscribed ? (
            <>
              <button
                onClick={handleDisable}
                disabled={busy || testing}
                className="btn-brutal bg-white px-3 py-1.5 text-xs"
              >
                {busy ? formatMessage({ id: "settings.notifications.disabling" }) : formatMessage({ id: "settings.notifications.disable" })}
              </button>
              <button
                onClick={handleSendTest}
                disabled={busy || testing || permission === "unsupported" || !serverConfigured}
                className="btn-brutal bg-brutal-lime px-3 py-1.5 text-xs disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {testing ? formatMessage({ id: "settings.notifications.sending" }) : formatMessage({ id: "settings.notifications.sendTest" })}
              </button>
            </>
          ) : (
            <button
              onClick={handleEnable}
              disabled={busy || testing || permission === "unsupported" || !serverConfigured}
              className="btn-brutal bg-brutal-pink px-3 py-1.5 text-xs disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {busy ? formatMessage({ id: "settings.notifications.enabling" }) : formatMessage({ id: "settings.notifications.enable" })}
            </button>
          )}
        </div>

        {currentServer && (
          <div className="border-t-2 border-black/20 pt-3">
            <form onSubmit={handleSaveServerMute} className="space-y-3">
              <label className={`flex items-start gap-3 ${loading || busy || testing || muting ? "opacity-60" : ""}`}>
                <Checkbox
                  size="md"
                  checked={serverPushMuted}
                  disabled={loading || busy || testing || muting}
                  onChange={(event) => {
                    setServerPushMuted(event.currentTarget.checked);
                    setMessage("");
                    setError("");
                  }}
                  className="mt-0.5"
                />
                <span className="min-w-0">
                  <span className="block text-sm font-bold text-black">{formatMessage({ id: "settings.notifications.muteServerTitle" })}</span>
                  <span className="block text-xs text-black/60 mt-0.5">
                    {formatMessage({ id: "settings.notifications.muteServerDescription" }, { serverName: currentServer.name })}
                  </span>
                </span>
              </label>
              <div className="flex justify-end">
                <button
                  type="submit"
                  disabled={serverPushMuted === savedServerPushMuted || loading || busy || testing || muting}
                  className="btn-brutal bg-brutal-pink px-3 py-1.5 text-xs disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {muting ? formatMessage({ id: "settings.common.saving" }) : formatMessage({ id: "settings.common.save" })}
                </button>
              </div>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Invites Section ──

interface PendingInvite {
  id: string;
  invitedEmail: string;
  createdAt: string;
}

interface JoinLinkRecord {
  id: string;
  token: string;
  createdAt: string;
  expiresAt: string | null;
  maxUses: number | null;
  useCount: number;
  revokedAt: string | null;
}

interface OAuthClientRecord {
  id: string;
  serverId: string;
  clientId: string;
  appType: "server_local" | "slock_builtin" | "third_party_global";
  publishStatus: "private" | "publish_requested" | "in_review" | "published" | "rejected" | "unpublish_requested";
  category: OAuthClientCategory;
  dataAccessSummary: string | null;
  publishRejectionReason: string | null;
  name: string;
  description: string | null;
  homepageUrl: string | null;
  returnUrl: string | null;
  agentManifestUrl: string | null;
  allowedScopes: string[] | null;
  logoUrl: string | null;
  humanMarketplaceVisible: boolean;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
}

interface BuiltInOAuthClientRecord {
  id: string;
  clientId: string;
  appType: "slock_builtin";
  name: string;
  description: string | null;
  homepageUrl: string | null;
  agentManifestUrl: string | null;
  allowedScopes: string[] | null;
  humanMarketplaceVisible: boolean;
  createdAt: string;
  updatedAt: string;
}

interface MarketplaceOAuthClientRecord extends OAuthClientRecord {
  installedAt: string | null;
  marketplaceInstallBadge: MarketplaceInstallBadge;
  publisherName: string | null;
  publisherServerName: string | null;
  privateShared: boolean;
  appNotificationGroups: AppNotificationSelection["groups"];
  appNotificationEvents: AppNotificationSelection["events"];
  appNotificationReviewPending: boolean;
}

type MarketplaceInstallBadge =
  | { kind: "new" }
  | { kind: "bucket"; bucket: "10_plus" | "100_plus" | "1k_plus" }
  | { kind: "none" };

interface OAuthClientShareLinkRecord {
  id: string;
  clientId: string;
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface IntegrationOverviewItem {
  id: string;
  type: "pending" | "active";
  clientId: string;
  clientKey: string;
  clientName: string;
  agentName: string;
  agentDisplayName: string | null;
  scopes: string[];
  revokedAt: string | null;
}

function ProfileSection() {
  const { formatMessage } = useIntl();
  const server = useServerStore((s) => s.current);
  const updateServerProfile = useServerStore((s) => s.updateServerProfile);
  const uploadServerAvatar = useServerStore((s) => s.uploadServerAvatar);
  const { capabilities } = useServerPermissions();
  const canEdit = capabilities.editServerSettings;

  const [name, setName] = useState(server?.name ?? "");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const [avatarSaving, setAvatarSaving] = useState(false);
  const [avatarError, setAvatarError] = useState("");

  useEffect(() => {
    setName(server?.name ?? "");
  }, [server?.id, server?.name]);

  if (!server) return null;

  const serverInitial = (server.name || "S").trim().charAt(0).toUpperCase() || "S";
  const dirty =
    name.trim().length > 0
    && name.trim() !== server.name;

  const handleUploadAvatar = async (file: File) => {
    if (isAvatarFileTooLarge(file)) {
      setAvatarError(formatMessage({ id: "avatar.tooLarge" }, { maxLabel: formatMessage({ id: "common.fileSize.maxLabel5mb" }) }));
      return;
    }
    setAvatarError("");
    setAvatarSaving(true);
    try {
      await uploadServerAvatar(file);
    } catch (err: any) {
      setAvatarError(isAvatarTooLargeError(err)
        ? formatMessage({ id: "avatar.tooLarge" }, { maxLabel: formatMessage({ id: "common.fileSize.maxLabel5mb" }) })
        : avatarUploadApiErrorMessage(err, formatMessage({ id: "settings.serverProfile.failedUploadAvatar" })));
    } finally {
      setAvatarSaving(false);
    }
  };

  const handleSave = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setSaved(false);
    setSaving(true);
    try {
      await updateServerProfile({
        name: name.trim(),
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err: any) {
      setError(err.response?.data?.error || formatMessage({ id: "settings.serverProfile.failedUpdate" }));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mb-6">
      <SectionHeader
        className="mb-3"
        icon={<Building2 size={16} />}
        label={formatMessage({ id: "settings.serverProfile.sectionLabel" })}
      />

      <SettingsProfileCard
        testId="server-profile-card"
        title={server.name}
        subtitle={`/${server.slug}`}
        avatar={
          canEdit ? (
            <label
              className={`group relative flex size-16 shrink-0 items-center justify-center ${avatarSaving ? "cursor-not-allowed opacity-70" : ""}`}
              title={avatarSaving ? formatMessage({ id: "settings.common.uploadingAvatar" }) : formatMessage({ id: "settings.common.uploadImage" })}
              aria-label={avatarSaving ? formatMessage({ id: "settings.common.uploadingAvatar" }) : formatMessage({ id: "settings.common.uploadImage" })}
            >
              <AvatarSlot context="profile-tile" type="server" serverAvatarUrl={server.avatarUrl} serverInitial={serverInitial} />
              <span className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 transition-opacity group-hover:opacity-100">
                <Upload size={18} className="text-white" />
              </span>
              <input
                type="file"
                accept={PROFILE_AVATAR_ACCEPT}
                className="hidden"
                disabled={avatarSaving}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.currentTarget.value = "";
                  if (file) void handleUploadAvatar(file);
                }}
              />
            </label>
          ) : (
            <AvatarSlot context="profile-tile" type="server" serverAvatarUrl={server.avatarUrl} serverInitial={serverInitial} className="border-black/30" />
          )
        }
      >
        {avatarError ? (
          <p className="text-xs font-bold text-brutal-red" role="alert">{avatarError}</p>
        ) : null}
        <form onSubmit={handleSave} className="space-y-3">
          <FormField label={formatMessage({ id: "settings.serverProfile.nameLabel" })} labelStyle="plain" size="compact">
            {canEdit ? (
              <input
                data-testid="server-profile-name-input"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={100}
                className="w-full border-2 border-black p-2 text-sm shadow-brutal-sm focus:shadow-brutal focus:outline-none"
              />
            ) : (
              <div
                data-testid="server-profile-name-readonly"
                className="w-full border-2 border-black/30 bg-gray-50 p-2 text-sm font-mono text-black/60"
              >
                {server.name}
              </div>
            )}
          </FormField>

          <FormField label={formatMessage({ id: "settings.serverProfile.slugLabel" })} labelStyle="plain" size="compact">
            <SlugInput
              type="text"
              value={server.slug}
              readOnly
              aria-readonly="true"
              tabIndex={-1}
              className="border-black/30 bg-gray-50 shadow-none focus-within:shadow-none"
              inputClassName="cursor-default text-sm text-black/60"
            />
          </FormField>

          {error && (
            <Banner intent="warning" density="sm" className="font-bold">{error}</Banner>
          )}

          {canEdit && (
            <button
              data-testid="server-profile-save-button"
              data-save-state={saving ? "saving" : saved ? "saved" : dirty ? "dirty" : "pristine"}
              type="submit"
              disabled={!dirty || saving}
              className="btn-brutal bg-brutal-pink px-3 py-1.5 text-xs flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving ? formatMessage({ id: "settings.common.saving" }) : saved ? (
                <><Check size={14} /> {formatMessage({ id: "settings.common.saved" })}</>
              ) : formatMessage({ id: "settings.serverProfile.saveProfile" })}
            </button>
          )}
        </form>
      </SettingsProfileCard>
    </div>
  );
}

interface PublicVisibilityReadback {
  publiclyVisible: boolean;
  slug: string;
  exposedChannels: Array<{ id: string; name: string; description: string | null }>;
}

interface PublicVisibilityUiState {
  readback: PublicVisibilityReadback | null;
  loading: boolean;
  saving: boolean;
  error: string;
  confirmOpen: boolean;
}

type PublicVisibilityUiAction =
  | { type: "load" }
  | { type: "loaded"; readback: PublicVisibilityReadback }
  | { type: "failed"; error: string }
  | { type: "saving" }
  | { type: "saved"; publiclyVisible: boolean }
  | { type: "confirm"; open: boolean };

function publicVisibilityUiReducer(state: PublicVisibilityUiState, action: PublicVisibilityUiAction): PublicVisibilityUiState {
  switch (action.type) {
    case "load": return { ...state, readback: null, loading: true, error: "", confirmOpen: false };
    case "loaded": return { ...state, loading: false, readback: action.readback };
    case "failed": return { ...state, loading: false, saving: false, error: action.error };
    case "saving": return { ...state, saving: true, error: "" };
    case "saved": return {
      ...state,
      saving: false,
      readback: state.readback ? { ...state.readback, publiclyVisible: action.publiclyVisible } : null,
    };
    case "confirm": return { ...state, confirmOpen: action.open };
  }
}

function PublicChannelList({ channels }: { channels: PublicVisibilityReadback["exposedChannels"] }) {
  const { formatMessage } = useIntl();
  // Keep the exposure inventory compact in both the settings page and the
  // confirmation drawer. A row has a fixed 3.625rem detail height; the 7.5rem
  // border-box therefore shows exactly two rows (plus the list borders), with
  // any third row reached inside this list instead of growing its parent.
  const scrollFrameClass = "max-h-[7.5rem] overflow-y-scroll";
  if (channels.length === 0) {
    return (
      <div className={`border-2 border-dashed border-black/25 bg-gray-50 px-3 py-4 text-center text-xs text-black/55 ${scrollFrameClass}`}>
        {formatMessage({ id: "settings.publicVisibility.emptyChannels" })}
      </div>
    );
  }
  return (
    <ul className={`divide-y divide-black/10 border-2 border-black bg-white ${scrollFrameClass}`} data-testid="public-visibility-channel-list">
      {channels.map((channel) => (
        <li key={channel.id} className="flex h-[3.625rem] items-start gap-3 px-3 py-2.5">
          <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center border border-black bg-brutal-cream" aria-hidden="true">
            <Hash size={14} strokeWidth={2.5} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-bold text-black">{channel.name}</span>
            {channel.description ? <span className="mt-0.5 block truncate text-xs text-black/55">{channel.description}</span> : null}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function PublicVisibilitySection() {
  const { formatMessage } = useIntl();
  const server = useServerStore((s) => s.current);
  const { role } = useServerPermissions();
  const publicServerEnabled = useServerFeatureFlag(PUBLIC_SERVER_FEATURE_FLAG_KEY).enabled;
  const [ui, dispatch] = useReducer(publicVisibilityUiReducer, {
    readback: null,
    loading: false,
    saving: false,
    error: "",
    confirmOpen: false,
  });
  const { readback, loading, saving, error, confirmOpen } = ui;

  useEffect(() => {
    if (!server?.id || role !== "owner" || !publicServerEnabled) return;
    let active = true;
    dispatch({ type: "load" });
    api.get<PublicVisibilityReadback>(`/servers/${server.id}/public-visibility`)
      .then(({ data }) => {
        if (active) dispatch({ type: "loaded", readback: data });
      })
      .catch((err: unknown) => {
        if (active) {
          const response = getApiErrorResponse(err);
          dispatch({ type: "failed", error: response?.error || formatMessage({ id: "settings.publicVisibility.failedLoad" }) });
        }
      });
    return () => {
      active = false;
    };
  }, [formatMessage, publicServerEnabled, role, server?.id]);

  if (!server || role !== "owner" || !publicServerEnabled) return null;

  const updateVisibility = async (publiclyVisible: boolean) => {
    dispatch({ type: "saving" });
    try {
      const { data } = await api.patch<{ publiclyVisible: boolean }>(`/servers/${server.id}/public-visibility`, { publiclyVisible });
      if (useServerStore.getState().current?.id !== server.id) return;
      dispatch({ type: "saved", publiclyVisible: data.publiclyVisible });
    } catch (err: unknown) {
      if (useServerStore.getState().current?.id !== server.id) return;
      const response = getApiErrorResponse(err);
      dispatch({ type: "failed", error: response?.error || formatMessage({ id: "settings.publicVisibility.failedUpdate" }) });
      throw err;
    }
  };

  const channels = readback?.exposedChannels ?? [];
  const publicUrl = readback?.publiclyVisible
    ? `${window.location.origin}/s/${readback.slug}`
    : "";

  return (
    <div className="mb-6" data-testid="public-visibility-section">
      <SectionHeader
        className="mb-3"
        icon={<Globe2 size={16} />}
        label={formatMessage({ id: "settings.publicVisibility.sectionLabel" })}
      />
      <div className="space-y-4 border-2 border-black bg-white p-4 shadow-brutal-sm">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h3 id="public-visibility-label" className="text-sm font-bold text-black">
              {formatMessage({ id: "settings.publicVisibility.title" })}
            </h3>
            <p className="mt-1 text-xs leading-relaxed text-black/60">
              {formatMessage({ id: "settings.publicVisibility.description" })}
            </p>
          </div>
          <Switch
            size="md"
            checked={readback?.publiclyVisible === true}
            disabled={loading || saving || !readback}
            onCheckedChange={(checked) => {
              if (checked) dispatch({ type: "confirm", open: true });
              else void updateVisibility(false).catch(() => {});
            }}
            aria-labelledby="public-visibility-label"
            data-testid="public-visibility-switch"
          />
        </div>

        {publicUrl ? (
          <div data-testid="public-visibility-url">
            <label
              htmlFor="public-visibility-url-input"
              className="mb-1 block text-xs font-bold uppercase tracking-wide text-black/60"
            >
              {formatMessage({ id: "settings.publicVisibility.publicUrl" })}
            </label>
            <div className="flex gap-2">
              <input
                id="public-visibility-url-input"
                className="input-brutal h-10 min-w-0 flex-1 text-xs"
                type="url"
                value={publicUrl}
                readOnly
              />
              <CopyButton
                text={publicUrl}
                resetKey={publicUrl}
                onCopyError={() => dispatch({
                  type: "failed",
                  error: formatMessage({ id: "settings.publicVisibility.failedCopyUrl" }),
                })}
              >
                {({ copied, disabled, onClick, onMouseDown }) => (
                  <Button
                    size="lg"
                    shape="iconText"
                    tone="white"
                    className="shrink-0"
                    disabled={disabled}
                    onMouseDown={onMouseDown}
                    onClick={onClick}
                    data-testid="public-visibility-copy-url"
                  >
                    {copied ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
                    {formatMessage({
                      id: copied
                        ? "settings.publicVisibility.copiedUrl"
                        : "settings.publicVisibility.copyUrl",
                    })}
                  </Button>
                )}
              </CopyButton>
            </div>
          </div>
        ) : null}

        <div>
          <p className="mb-2 text-xs font-bold uppercase tracking-wide text-black/60">
            {formatMessage({ id: "settings.publicVisibility.channelListLabel" })}
          </p>
          {loading ? (
            <div className="h-16 animate-pulse border-2 border-black/15 bg-gray-100" data-testid="public-visibility-loading" />
          ) : <PublicChannelList channels={channels} />}
        </div>

        {error ? <Banner intent="warning" density="sm" className="font-bold">{error}</Banner> : null}
      </div>

      {confirmOpen ? (
        <ConfirmDialog
          title={formatMessage({ id: "settings.publicVisibility.confirmTitle" })}
          message={(
            <div className="space-y-4">
              <p className="text-sm leading-relaxed text-black/75">
                {formatMessage({ id: "settings.publicVisibility.confirmDescription" })}
              </p>
              <PublicChannelList channels={channels} />
              <p className="text-xs leading-relaxed text-black/60">
                {formatMessage({ id: "settings.publicVisibility.confirmAudienceChange" })}
              </p>
            </div>
          )}
          confirmLabel={formatMessage({ id: "settings.publicVisibility.confirmAction" })}
          loadingLabel={formatMessage({ id: "settings.publicVisibility.confirmSaving" })}
          confirmColor="bg-brutal-pink"
          confirmTestId="public-visibility-confirm-button"
          plainMessage
          maxWidthClass="max-w-lg"
          chromeLocale="active"
          onConfirm={() => updateVisibility(true)}
          onClose={() => dispatch({ type: "confirm", open: false })}
        />
      ) : null}
    </div>
  );
}

interface ServerLabsSavingTarget {
  serverId: string;
  serverEpoch: number;
  token: number;
  target: string;
}

function LabsSection() {
  const { formatMessage } = useIntl();
  const current = useServerStore((s) => s.current);
  const serverEpoch = useServerStore((s) => s.serverEpoch);
  const { role } = useServerPermissions();
  const { readback, loading, unavailable, errorId } = useServerLabsSettingsSnapshot(current?.id, serverEpoch);
  const [savingTarget, setSavingTarget] = useState<ServerLabsSavingTarget | null>(null);
  const mutationRequestTokenRef = useRef(0);
  const activeServerId = current?.id ?? null;
  const activeReadback = readback?.serverId === activeServerId ? readback : null;
  const activeSavingTarget = savingTarget?.serverId === activeServerId && savingTarget.serverEpoch === serverEpoch ? savingTarget : null;

  const authority = useMemo(
    () => getServerLabSettingsAuthority(role, activeReadback?.permissions),
    [activeReadback?.permissions, role],
  );

  const isActiveServerLabsContext = (context: ServerLabsStoreContext) => {
    const serverState = useServerStore.getState();
    return serverState.current?.id === context.serverId && serverState.serverEpoch === context.serverEpoch;
  };

  useEffect(() => {
    if (!current?.id) return;
    const requestContext = createServerLabsStoreContext(current.id, serverEpoch);
    loadServerLabsSettings(requestContext).catch(() => {});
  }, [current?.id, serverEpoch]);

  if (!current) return null;

  const applyReadbackMutation = async (
    target: string,
    requestFactory: (serverId: string, snapshot: ServerLabSettingsReadback) => Promise<{ data: ServerLabSettingsReadback | CanonicalServerLabSettingsReadback | { data: ServerLabSettingsReadback | CanonicalServerLabSettingsReadback } }>,
  ) => {
    if (!activeServerId || !activeReadback || activeReadback.serverId !== activeServerId) return;
    const requestContext: ServerLabsStoreContext = {
      serverId: activeServerId,
      serverEpoch,
      token: mutationRequestTokenRef.current + 1,
    };
    mutationRequestTokenRef.current = requestContext.token;
    beginServerLabsMutation(requestContext);
    setSavingTarget({
      serverId: requestContext.serverId,
      serverEpoch: requestContext.serverEpoch,
      token: requestContext.token,
      target,
    });
    try {
      const response = await requestFactory(requestContext.serverId, activeReadback);
      if (!isActiveServerLabsContext(requestContext) || mutationRequestTokenRef.current !== requestContext.token) return;
      const normalized = normalizeServerLabSettingsReadback(response.data);
      if (normalized.serverId !== requestContext.serverId) {
        failServerLabsMutation(requestContext, "settings.labs.failedServerMismatch");
        return;
      }
      const published = publishServerLabsReadback(requestContext, normalized, "mutation");
      if (published) void refreshServerFeatureFlags(requestContext.serverId);
    } catch {
      if (!isActiveServerLabsContext(requestContext) || mutationRequestTokenRef.current !== requestContext.token) return;
      failServerLabsMutation(requestContext, "settings.labs.failedUpdate");
    } finally {
      if (isActiveServerLabsContext(requestContext) && mutationRequestTokenRef.current === requestContext.token) {
        setSavingTarget((existing) => (
          existing?.serverId === requestContext.serverId && existing.serverEpoch === requestContext.serverEpoch && existing.token === requestContext.token ? null : existing
        ));
      }
    }
  };

  const handleMasterChange = (enabled: boolean) => {
    if (!activeReadback || !authority.canSetMasterAccess) return;
    void applyReadbackMutation(
      "master",
      (serverId, snapshot) => api.patch(`/servers/${serverId}/labs/access`, createServerLabMasterMutation(snapshot, enabled)),
    );
  };

  const handleEnrollmentChange = (labKey: string, enabled: boolean) => {
    if (!activeReadback) return;
    const lab = activeReadback.labs.find((candidate) => candidate.key === labKey);
    if (!lab || !isServerLabEnrollmentEditable(lab, authority, activeReadback.masterEnabled)) return;
    void applyReadbackMutation(
      `lab:${labKey}`,
      (serverId, snapshot) => api.put(`/servers/${serverId}/labs/${encodeURIComponent(labKey)}`, createServerLabEnrollmentMutation(snapshot, enabled)),
    );
  };

  const error = errorId ? formatMessage({ id: errorId }) : "";

  return (
    <div className="mb-6">
      <SectionHeader
        className="mb-3"
        icon={<FlaskConical size={16} />}
        label={formatMessage({ id: "settings.labs.sectionLabel" })}
        count={activeReadback?.labs.length}
      />

      <div className="border-2 border-black bg-white p-4 shadow-brutal-sm">
        {loading ? (
          <div className="space-y-3">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : unavailable ? (
          <div className="flex items-start gap-3 text-sm text-black/60">
            <AlertTriangle size={16} className="mt-0.5 shrink-0 text-black/50" />
            <div>
              <div className="font-bold text-black">{formatMessage({ id: "settings.labs.unavailableTitle" })}</div>
              <div className="mt-1 text-xs leading-5">{formatMessage({ id: "settings.labs.unavailableDescription" })}</div>
            </div>
          </div>
        ) : activeReadback ? (
          <div className="space-y-4">
            <div className="flex items-start justify-between gap-4 border-b-2 border-black pb-4">
              <div className="min-w-0">
                <div className="text-sm font-bold text-black">{formatMessage({ id: "settings.labs.masterTitle" })}</div>
                {!authority.canSetMasterAccess && (
                  <div className="mt-1 text-xs font-mono text-black/45">
                    {formatMessage({ id: "settings.labs.masterOwnerOnly" })}
                  </div>
                )}
              </div>
              <Switch
                size="md"
                checked={activeReadback.masterEnabled}
                disabled={!authority.canSetMasterAccess || activeSavingTarget != null}
                onCheckedChange={handleMasterChange}
                aria-label={formatMessage({ id: "settings.labs.masterTitle" })}
                className="mt-0.5 shrink-0"
              />
            </div>

            {activeReadback.labs.length === 0 ? (
              <div className="text-xs text-black/40 italic">{formatMessage({ id: "settings.labs.emptyState" })}</div>
            ) : (
              <div className="divide-y-2 divide-black/10" data-testid="server-labs-list">
                {activeReadback.labs.map((lab) => {
                  const editable = isServerLabEnrollmentEditable(lab, authority, activeReadback.masterEnabled);
                  const disabledReasonId = getServerLabEnrollmentDisabledReasonMessageId(lab, authority, activeReadback.masterEnabled);
                  const disabledReason = disabledReasonId ? formatMessage({ id: disabledReasonId }) : "";
                  const descriptionId = getServerLabDescriptionMessageId(lab.key);
                  const description = descriptionId ? formatMessage({ id: descriptionId }) : lab.description;
                  const checked = activeReadback.masterEnabled && lab.enrolled;
                  const saving = activeSavingTarget?.target === `lab:${lab.key}`;
                  return (
                    <div
                      key={lab.key}
                      data-testid="server-lab-row"
                      className={`grid grid-cols-[minmax(0,1fr)_44px] items-start gap-4 py-3 first:pt-0 last:pb-0 ${!editable ? "opacity-60" : ""}`}
                    >
                      <div className="min-w-0">
                        <div className="flex min-w-0 flex-wrap items-center gap-2">
                          <span className="min-w-0 truncate text-sm font-bold text-black">{lab.name}</span>
                        </div>
                        <div className="mt-1 text-xs leading-5 text-black/60">{description}</div>
                        {disabledReason && (
                          <div className="mt-1 text-xs font-mono text-black/45">{disabledReason}</div>
                        )}
                      </div>
                      <Switch
                        size="md"
                        checked={checked}
                        disabled={!editable || activeSavingTarget != null}
                        onCheckedChange={(enabled) => handleEnrollmentChange(lab.key, enabled)}
                        aria-label={formatMessage({ id: "settings.labs.enrollmentAria" }, { name: lab.name })}
                        className="mt-0.5 justify-self-end"
                        title={disabledReason || undefined}
                      />
                      {saving && (
                        <span className="sr-only">
                          {formatMessage({ id: "settings.labs.savingEnrollment" }, { name: lab.name })}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {error && (
              <Banner intent="warning" density="sm" className="font-bold">
                {error}
              </Banner>
            )}
          </div>
        ) : error ? (
          <Banner intent="warning" density="sm" className="font-bold">
            {error}
          </Banner>
        ) : null}
      </div>
    </div>
  );
}

function AdminsSection() {
  const { formatMessage } = useIntl();
  const members = useServerStore((s) => s.members);
  const loadMembers = useServerStore((s) => s.loadMembers);
  const updateMemberRole = useServerStore((s) => s.updateMemberRole);
  const allAgents = useAgentStore((s) => s.agents);
  const loadAgents = useAgentStore((s) => s.loadAgents);
  const updateAgent = useAgentStore((s) => s.updateAgent);
  const { role, capabilities } = useServerPermissions();

  const pickerRef = useRef<HTMLDivElement>(null);
  const agents = useMemo(() => allAgents.filter((agent) => !agent.deletedAt), [allAgents]);
  const [selectedPrincipalKey, setSelectedPrincipalKey] = useState("");
  const [selectedRole, setSelectedRole] = useState<Extract<ServerRole, "owner" | "admin">>("admin");
  const [adminPrincipalSearch, setAdminPrincipalSearch] = useState("");
  const [principalPickerOpen, setPrincipalPickerOpen] = useState(false);
  const [savingPrincipalKey, setSavingPrincipalKey] = useState<string | null>(null);
  const [error, setError] = useState("");

  const canManageAdminRoles = capabilities.changeMemberRoles;
  const admins = useMemo(() => getAdminPrincipals(members, agents), [members, agents]);
  const candidates = useMemo(() => getAdminCandidatePrincipals(members, agents, role), [members, agents, role]);
  // oxlint-disable-next-line react-doctor/no-event-handler -- YMNNE-family: pre-existing non-bug site grandfathered; rule now gates new code (see docs/frontend/render-cost-contract.md)
  const selectedCandidate = candidates.find((principal) => getAdminPrincipalKey(principal) === selectedPrincipalKey) ?? null;
  const selectedRoleOptions = selectedCandidate ? getAdminPrincipalRoleOptions(role, selectedCandidate) : [];
  const adminRoleSelectOptions: SelectOption[] = [
    { value: "owner", label: formatMessage({ id: "settings.admins.owner" }), disabled: !selectedRoleOptions.includes("owner") },
    { value: "admin", label: formatMessage({ id: "settings.admins.admin" }), disabled: !selectedRoleOptions.includes("admin") },
  ];
  const ownerCount = members.filter((member) => member.role === "owner").length;
  const filteredCandidates = useMemo(() => {
    if (!adminPrincipalSearch.trim()) return candidates;
    const needle = adminPrincipalSearch.trim().toLowerCase();
    return candidates.filter((principal) => {
      const label = getAdminPrincipalLabel(principal, formatMessage).toLowerCase();
      const identity = principal.kind === "human"
        ? [principal.email, principal.name].filter(Boolean).join(" ")
        : `@${principal.name}`;
      return `${label} ${identity}`.toLowerCase().includes(needle);
    });
  }, [adminPrincipalSearch, candidates, formatMessage]);

  useEffect(() => {
    if (!canManageAdminRoles) return;
    void loadMembers();
    void loadAgents();
  }, [canManageAdminRoles, loadAgents, loadMembers]);

  useEffect(() => {
    // oxlint-disable-next-line react-doctor/no-event-handler -- YMNNE-family: pre-existing non-bug site grandfathered; rule now gates new code (see docs/frontend/render-cost-contract.md)
    if (selectedPrincipalKey && !candidates.some((principal) => getAdminPrincipalKey(principal) === selectedPrincipalKey)) {
      // oxlint-disable-next-line react-doctor/no-chain-state-updates -- YMNNE-family: pre-existing non-bug site grandfathered; rule now gates new code (see docs/frontend/render-cost-contract.md)
      setSelectedPrincipalKey("");
    }
  }, [candidates, selectedPrincipalKey]);

  useEffect(() => {
    if (!principalPickerOpen) return;
    // Reset search input when dropdown opens. Intentional reset-on-open, not
    // prop-derived state.
    // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change
    setAdminPrincipalSearch("");
    const handleClickOutside = (event: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(event.target as Node)) {
        setPrincipalPickerOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [principalPickerOpen]);

  // List-dep default narrowing: when the candidate (or current admin's own
  // role) changes, the available admin role options shrink/grow; fall the
  // user's `selectedRole` back to the first option if their previous pick
  // isn't in the new set. NOT a mirror-prop pattern — `selectedRole` is a
  // user-editable choice that must be narrowed when the available set
  // shifts. Same shape as CreateAgentDialog's list-dep default in PR #2524.
  useEffect(() => {
    if (!selectedCandidate) {
      // oxlint-disable-next-line react-doctor/no-derived-state, react-doctor/no-chain-state-updates -- YMNNE-family: pre-existing non-bug site grandfathered; rule now gates new code (see docs/frontend/render-cost-contract.md)
      setSelectedRole("admin");
      return;
    }
    const options = getAdminPrincipalRoleOptions(role, selectedCandidate);
    // oxlint-disable-next-line react-doctor/no-event-handler -- YMNNE-family: pre-existing non-bug site grandfathered; rule now gates new code (see docs/frontend/render-cost-contract.md)
    if (!options.includes(selectedRole)) {
      // oxlint-disable-next-line react-doctor/no-derived-state
      setSelectedRole(options[0] ?? "admin");
    }
  }, [role, selectedCandidate, selectedRole]);

  if (!canManageAdminRoles) return null;

  const formatAdminRoleLabel = (role: string) => {
    if (role === "owner") return formatMessage({ id: "member.roles.owner" });
    if (role === "admin") return formatMessage({ id: "member.roles.admin" });
    if (role === "member") return formatMessage({ id: "member.roles.member" });
    return role;
  };
  const getPrincipalSubtitle = (principal: ServerAdminSettingsPrincipal) => {
    const roleLabel = formatAdminRoleLabel(principal.role);
    return principal.kind === "human"
      ? principal.email ? `${principal.email} · ${roleLabel}` : roleLabel
      : formatMessage({ id: "settings.admins.agentPrefix" }, { role: roleLabel });
  };

  const renderPrincipalAvatar = (principal: ServerAdminSettingsPrincipal, context: "surface-list" | "compact-list") => (
    principal.kind === "human" ? (
      <AvatarSlot
        context={context}
        type="human"
        humanAvatarUrl={principal.avatarUrl}
        gravatarHash={principal.gravatarHash}
        email={principal.email}
        className={context === "surface-list" ? "self-start" : ""}
      />
    ) : (
      <AvatarSlot
        context={context}
        type="agent"
        agentAvatarUrl={principal.avatarUrl}
        className={context === "surface-list" ? "self-start" : ""}
      />
    )
  );

  const popoverOptions = filteredCandidates.map((principal) => {
    const key = getAdminPrincipalKey(principal);
    return {
      key,
      checked: key === selectedPrincipalKey,
      onClick: () => {
        setSelectedPrincipalKey(key);
        setPrincipalPickerOpen(false);
        setAdminPrincipalSearch("");
      },
      label: principal.kind === "human"
        ? principal.email ? `${getAdminPrincipalLabel(principal, formatMessage)} · ${principal.email}` : getAdminPrincipalLabel(principal, formatMessage)
        : formatMessage(
          { id: "settings.admins.principalAgentSuffix" },
          { name: getAdminPrincipalLabel(principal, formatMessage) },
        ),
      reserveLeadingSlot: true,
      avatar: renderPrincipalAvatar(principal, "compact-list"),
    };
  });

  const updateAdminPrincipalRole = (
    principal: ServerAdminSettingsPrincipal,
    nextRole: Extract<ServerRole, "owner" | "admin" | "member">,
  ) => {
    if (principal.kind === "human") {
      return updateMemberRole(principal.userId, nextRole);
    }
    const agentRole: Extract<ServerRole, "admin" | "member"> = nextRole === "member" ? "member" : "admin";
    return updateAgent(principal.id, { serverRole: agentRole });
  };

  const handlePromote = async () => {
    if (!selectedCandidate) return;
    const key = getAdminPrincipalKey(selectedCandidate);
    setSavingPrincipalKey(key);
    setError("");
    try {
      await updateAdminPrincipalRole(selectedCandidate, selectedRole);
      setSelectedPrincipalKey("");
    } catch (err: any) {
      setError(err.response?.data?.error || formatMessage({ id: "settings.admins.failedUpdateRole" }));
    } finally {
      setSavingPrincipalKey(null);
    }
  };

  const handleDemote = async (principal: ServerAdminSettingsPrincipal) => {
    const key = getAdminPrincipalKey(principal);
    setSavingPrincipalKey(key);
    setError("");
    try {
      await updateAdminPrincipalRole(principal, "member");
    } catch (err: any) {
      setError(err.response?.data?.error || formatMessage({ id: "settings.admins.failedRemoveRole" }));
    } finally {
      setSavingPrincipalKey(null);
    }
  };

  return (
    <div className="mb-6">
      <SectionHeader
        className="mb-3"
        icon={<Shield size={16} />}
        label={formatMessage({ id: "settings.admins.sectionLabel" })}
        count={admins.length}
      />

      <div className="border-2 border-black bg-white shadow-brutal-sm p-4 space-y-4">
        <div>
          <div className="mb-2 text-xs font-bold text-black/60">{formatMessage({ id: "settings.admins.addLabel" })}</div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <div ref={pickerRef} className="relative min-w-0 sm:flex-[1_1_0%]">
              <button
                type="button"
                data-testid="admin-principal-picker"
                onClick={() => setPrincipalPickerOpen((open) => !open)}
                disabled={candidates.length === 0 || savingPrincipalKey != null}
                className="flex h-10 w-full min-w-0 items-center justify-between gap-2 border-2 border-black bg-white px-3 text-left text-xs font-bold shadow-brutal-sm transition-colors hover:bg-soft-signal/30 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <span className={`truncate ${selectedCandidate ? "text-black" : "text-black/45"}`}>
                  {selectedCandidate
                    ? selectedCandidate.kind === "human" && selectedCandidate.email
                      ? `${getAdminPrincipalLabel(selectedCandidate, formatMessage)} · ${selectedCandidate.email}`
                      : getAdminPrincipalLabel(selectedCandidate, formatMessage)
                    : candidates.length > 0 ? formatMessage({ id: "settings.admins.membersSearchPlaceholder" }) : formatMessage({ id: "settings.admins.noMembers" })}
                </span>
                <ChevronRight size={14} className={`shrink-0 transition-transform ${principalPickerOpen ? "rotate-90" : ""}`} />
              </button>
              {principalPickerOpen && (
                <SelectionPopover
                  title={formatMessage({ id: "settings.admins.membersPickerTitle" })}
                  width="trigger"
                  searchable
                  search={adminPrincipalSearch}
                  onSearchChange={setAdminPrincipalSearch}
                  searchPlaceholder={formatMessage({ id: "settings.admins.membersSearchPlaceholder" })}
                  emptyLabel={formatMessage({ id: "settings.admins.noMatchingMembers" })}
                  options={popoverOptions}
                  showClear={!!selectedCandidate}
                  onClear={() => {
                    setSelectedPrincipalKey("");
                    setPrincipalPickerOpen(false);
                  }}
                />
              )}
            </div>
            <div className="sm:w-[120px] sm:shrink-0">
              <Select
                value={selectedRole}
                onValueChange={(value) => {
                  if (value == null) return;
                  setSelectedRole(value as Extract<ServerRole, "owner" | "admin">);
                }}
                items={adminRoleSelectOptions}
                disabled={!selectedCandidate || selectedRoleOptions.length === 0 || savingPrincipalKey != null}
              >
                <SelectTrigger className="w-full min-w-[120px]">
                  <SelectValue placeholder={formatMessage({ id: "settings.admins.rolePlaceholder" })} />
                  <SelectIcon />
                </SelectTrigger>
                <SelectContent>
                  <SelectList>
                    {renderSelectItems(adminRoleSelectOptions)}
                  </SelectList>
                </SelectContent>
              </Select>
            </div>
            <button
              type="button"
              onClick={handlePromote}
              disabled={!selectedCandidate || selectedRoleOptions.length === 0 || savingPrincipalKey != null}
              className="btn-brutal bg-brutal-pink px-3 py-2 [@media(max-height:600px)]:py-1 text-xs disabled:opacity-50 disabled:cursor-not-allowed sm:shrink-0"
            >
              {selectedCandidate && savingPrincipalKey === getAdminPrincipalKey(selectedCandidate) ? formatMessage({ id: "settings.common.saving" }) : formatMessage({ id: "settings.admins.updateRole" })}
            </button>
          </div>
        </div>

        <div className="border-t-2 border-black pt-4">
          {admins.length > 0 ? (
            <div className="space-y-2">
              {admins.map((admin) => {
                const canRemove = canRemoveAdminPrincipal(role, admin, ownerCount);
                const label = admin.kind === "human" ? getMemberLabel(admin, formatMessage) : getAdminPrincipalLabel(admin, formatMessage);
                const key = getAdminPrincipalKey(admin);
                return (
                  <AvatarListRow
                    key={key}
                    avatar={
                      // stdrc #wg-theme:7470ca2a: admin avatar pins to the
                      // top of the row (so the avatar lines up with the
                      // first line — the name) while the Remove button on
                      // the right stays vertically centered. self-start on
                      // the avatar achieves that without disrupting the
                      // shared row alignment.
                      renderPrincipalAvatar(admin, "surface-list")
                    }
                    name={label}
                    subtitle={getPrincipalSubtitle(admin)}
                    rightContent={
                      canRemove ? (
                        <button
                          type="button"
                          onClick={() => handleDemote(admin)}
                          disabled={savingPrincipalKey != null}
                          className="btn-brutal-sm shrink-0 bg-white px-2 py-1 text-xs disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {savingPrincipalKey === key ? formatMessage({ id: "settings.common.saving" }) : admin.role === "owner" ? formatMessage({ id: "settings.admins.removeOwner" }) : formatMessage({ id: "settings.admins.removeAdmin" })}
                        </button>
                      ) : (
                        <span className="shrink-0 text-[10px] font-mono text-black/40">
                          {admin.role === "owner" && ownerCount <= 1 ? formatMessage({ id: "settings.admins.lastOwner" }) : formatMessage({ id: "settings.admins.ownerOnly" })}
                        </span>
                      )
                    }
                  />
                );
              })}
            </div>
          ) : (
            <div className="text-xs text-black/40 italic">
              {formatMessage({ id: "settings.admins.emptyState" })}
            </div>
          )}
        </div>

        {error && (
          <Banner intent="warning" density="sm" className="font-bold">
            {error}
          </Banner>
        )}
      </div>
    </div>
  );
}

function InvitesSection() {
  const { formatDate, formatMessage } = useIntl();
  const current = useServerStore((s) => s.current);
  const { capabilities } = useServerPermissions();

  const [invites, setInvites] = useState<PendingInvite[]>([]);
  const [loading, setLoading] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<PendingInvite | null>(null);

  const canInvite = capabilities.inviteMembers;

  useEffect(() => {
    if (current && canInvite) {
      loadInvites();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id, canInvite]);

  const loadInvites = async () => {
    if (!current) return;
    setLoading(true);
    try {
      const { data } = await api.get(`/servers/${current.id}/invites`);
      setInvites(data);
    } catch {
      // Ignore errors
    } finally {
      setLoading(false);
    }
  };

  const handleRevoke = async (inviteId: string) => {
    if (!current) return;
    try {
      await api.delete(`/servers/${current.id}/invites/${inviteId}`);
      await loadInvites();
    } catch {
      // Ignore
    }
  };

  if (!canInvite) return null;

  return (
    <div className="mb-6">
      <SectionHeader
        className="mb-3"
        icon={<Mail size={16} />}
        label={formatMessage({ id: "settings.invites.sectionLabel" })}
        count={invites.length > 0 ? invites.length : null}
      />

      <div className="border-2 border-black bg-white shadow-brutal-sm p-4">
        {invites.length > 0 ? (
          <div className="space-y-1.5">
            {invites.map((invite) => (
              <div
                key={invite.id}
                className="flex items-center gap-2 border-2 border-black/30 px-3 py-2"
              >
                <span className="flex-1 font-mono text-xs text-black truncate">
                  {invite.invitedEmail}
                </span>
                <span className="text-[10px] text-black/40 font-mono shrink-0">
                  {formatDate(invite.createdAt, {
                    month: "short",
                    day: "numeric",
                  })}
                </span>
                <button
                  onClick={() => setRevokeTarget(invite)}
                  className="shrink-0 btn-brutal-sm bg-white p-1"
                  title={formatMessage({ id: "settings.invites.revokeInviteTitle" })}
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        ) : !loading ? (
          <div className="text-xs text-black/40 italic">
            {formatMessage({ id: "settings.invites.emptyState" })}
          </div>
        ) : null}
      </div>

      {revokeTarget && (
        <ConfirmDialog
          chromeLocale="active"
          title={formatMessage({ id: "settings.invites.confirmTitle" })}
          message={formatMessage({ id: "settings.invites.confirmMessage" }, { email: revokeTarget.invitedEmail })}
          confirmLabel={formatMessage({ id: "settings.invites.confirmLabel" })}
          loadingLabel={formatMessage({ id: "settings.invites.revoking" })}
          onConfirm={() => handleRevoke(revokeTarget.id)}
          onClose={() => setRevokeTarget(null)}
        />
      )}
    </div>
  );
}

function JoinLinksSection() {
  const { formatMessage } = useIntl();
  const current = useServerStore((s) => s.current);
  const { capabilities } = useServerPermissions();
  const { formatShortDateTime } = useTimeFormatter();

  const [links, setLinks] = useState<JoinLinkRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");
  const [copiedLinkId, setCopiedLinkId] = useState<string | null>(null);
  const [maxUses, setMaxUses] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [revokeTarget, setRevokeTarget] = useState<JoinLinkRecord | null>(null);

  const canManageLinks = capabilities.inviteMembers;

  useEffect(() => {
    if (current && canManageLinks) {
      loadLinks();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id, canManageLinks]);

  const loadLinks = async () => {
    if (!current) return;
    setLoading(true);
    try {
      const { data } = await api.get(`/servers/${current.id}/join-links`);
      setLinks(data);
    } catch {
      // Ignore
    } finally {
      setLoading(false);
    }
  };

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault();
    if (!current) return;
    setCreating(true);
    setCreateError("");
    try {
      const { data } = await api.post(`/servers/${current.id}/join-links`, {
        maxUses: maxUses ? Number(maxUses) : null,
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
      });
      setLinks((prev) => [data.link, ...prev]);
    } catch (err: any) {
      setCreateError(err.response?.data?.error || formatMessage({ id: "settings.joinLinks.failedCreate" }));
    } finally {
      setCreating(false);
    }
  };

  const buildJoinLinkUrl = (token: string) => `${window.location.origin}/join/${token}`;

  const handleCopy = async (linkId: string, token: string) => {
    await navigator.clipboard.writeText(buildJoinLinkUrl(token));
    setCopiedLinkId(linkId);
    window.setTimeout(() => setCopiedLinkId((current) => current === linkId ? null : current), 1500);
  };

  const handleRevoke = async (linkId: string) => {
    if (!current) return;
    try {
      await api.delete(`/servers/${current.id}/join-links/${linkId}`);
      setLinks((prev) => prev.filter((link) => link.id !== linkId));
    } catch {
      // Ignore
    }
  };

  if (!canManageLinks) return null;

  return (
    <div className="mb-6">
      <SectionHeader
        className="mb-3"
        icon={<Link2 size={16} />}
        label={formatMessage({ id: "settings.joinLinks.sectionLabel" })}
        count={links.length > 0 ? links.length : null}
      />

      <div className="border-2 border-black bg-white shadow-brutal-sm p-4">
        <form onSubmit={handleCreate} className="space-y-3">
          <div className="grid gap-3 md:grid-cols-2">
            <FormField label={formatMessage({ id: "settings.joinLinks.maxUses" })} labelStyle="plain" size="compact" htmlFor="join-link-max-uses">
              <input
                id="join-link-max-uses"
                type="number"
                min="1"
                value={maxUses}
                onChange={(e) => setMaxUses(e.target.value)}
                placeholder={formatMessage({ id: "settings.joinLinks.unlimited" })}
                className="w-full border-2 border-black p-2 text-sm shadow-brutal-sm focus:shadow-brutal focus:outline-none"
              />
            </FormField>

            <FormField label={formatMessage({ id: "settings.joinLinks.expiresAt" })} labelStyle="plain" size="compact" htmlFor="join-link-expires-at">
              <input
                id="join-link-expires-at"
                type="datetime-local"
                value={expiresAt}
                onChange={(e) => setExpiresAt(e.target.value)}
                className="w-full border-2 border-black p-2 text-sm shadow-brutal-sm focus:shadow-brutal focus:outline-none"
              />
            </FormField>
          </div>

          {createError && (
            <Banner intent="warning" density="sm" className="font-bold">
              {createError}
            </Banner>
          )}

          <button
            type="submit"
            disabled={creating}
            className="btn-brutal bg-brutal-pink px-3 py-1.5 text-xs flex items-center gap-1.5"
          >
            <Plus size={14} />
            {creating ? formatMessage({ id: "settings.joinLinks.creating" }) : formatMessage({ id: "settings.joinLinks.createLink" })}
          </button>
        </form>

        <div className="mt-4 border-t-2 border-black pt-4">
          {links.length > 0 ? (
            <div className="space-y-2">
              {links.map((link) => (
                <div
                  key={link.id}
                  className="border-2 border-black/30 px-3 py-2.5 space-y-1.5"
                >
                  <div className="flex items-center gap-2">
                    <div className="min-w-0 flex-1 border-2 border-black bg-white px-2 py-1 font-mono text-[11px] truncate select-all">
                      {buildJoinLinkUrl(link.token)}
                    </div>
                    <button
                      onClick={() => handleCopy(link.id, link.token)}
                      className="btn-brutal-sm shrink-0 bg-white p-1.5"
                      title={formatMessage({ id: "settings.joinLinks.copyLink" })}
                    >
                      {copiedLinkId === link.id ? <Check size={14} /> : <Copy size={14} />}
                    </button>
                    <button
                      onClick={() => setRevokeTarget(link)}
                      className="btn-brutal-sm shrink-0 bg-white p-1.5"
                      title={formatMessage({ id: "settings.joinLinks.revokeLink" })}
                    >
                      <X size={14} />
                    </button>
                  </div>
                  <div className="text-[11px] text-black/50 font-mono">
                    {link.maxUses != null
                      ? formatMessage({ id: "settings.joinLinks.usesWithMax" }, { used: link.useCount, max: link.maxUses })
                      : formatMessage({ id: "settings.joinLinks.uses" }, { used: link.useCount })}
                    {" · "}
                    {link.expiresAt
                      ? formatMessage({ id: "settings.joinLinks.expires" }, { when: formatShortDateTime(link.expiresAt) })
                      : formatMessage({ id: "settings.joinLinks.noExpiry" })}
                  </div>
                </div>
              ))}
            </div>
          ) : !loading ? (
            <div className="text-xs text-black/40 italic">
              {formatMessage({ id: "settings.joinLinks.emptyState" })}
            </div>
          ) : null}
        </div>
      </div>

      {revokeTarget && (
        <ConfirmDialog
          chromeLocale="active"
          title={formatMessage({ id: "settings.joinLinks.confirmTitle" })}
          message={formatMessage({ id: "settings.joinLinks.confirmMessage" })}
          confirmLabel={formatMessage({ id: "settings.joinLinks.confirmLabel" })}
          loadingLabel={formatMessage({ id: "settings.joinLinks.revoking" })}
          onConfirm={() => handleRevoke(revokeTarget.id)}
          onClose={() => setRevokeTarget(null)}
        />
      )}
    </div>
  );
}

function OnboardingAgentSection() {
  const { formatMessage } = useIntl();
  const navigate = useNavigate();
  const current = useServerStore((s) => s.current);
  const loadServerSettings = useServerStore((s) => s.loadSettings);
  const allAgents = useAgentStore((s) => s.agents);
  const agents = useMemo(() => allAgents.filter((agent) => !agent.deletedAt), [allAgents]);
  const { capabilities, isAdminOrOwner } = useServerPermissions();

  const [onboardingAgentId, setOnboardingAgentId] = useState("");
  const [agentAllChannelGreetingEnabled, setAgentAllChannelGreetingEnabled] = useState(true);
  const [savedOnboardingAgentId, setSavedOnboardingAgentId] = useState("");
  const [savedAgentAllChannelGreetingEnabled, setSavedAgentAllChannelGreetingEnabled] = useState(true);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const [setupProjection, setSetupProjection] = useState<{
    surface: "none" | "computer_runtime" | "create_agent" | "complete" | "retry";
    phase: "not_started" | "in_progress" | "deferred" | "complete" | null;
  } | null>(null);
  const [reopeningSetup, setReopeningSetup] = useState(false);

  const canManageLinks = capabilities.editServerSettings;
  const onboardingAgentOptions: SelectOption[] = [
    { value: "", label: formatMessage({ id: "settings.onboarding.disabledOption" }) },
    ...agents.map((agent) => ({
      value: agent.id,
      label: `@${agent.name}${agent.displayName ? ` (${agent.displayName})` : ""}`,
    })),
  ];
  const agentGreetingOptions: SelectOption[] = [
    { value: "yes", label: formatMessage({ id: "settings.onboarding.yes" }) },
    { value: "no", label: formatMessage({ id: "settings.onboarding.no" }) },
  ];

  // oxlint-disable react-hooks/exhaustive-deps -- load onboarding settings only when the active server id (or permission) changes; depending on the whole `current` store object would refetch on unrelated server-store churn.
  // Async-loader: load onboarding-settings on server change. Same FP family
  // as PR #2530 useChannelMembers / InviteAcceptPage / AgentSkills loaders.
  // oxlint-disable-next-line react-doctor/no-cascading-set-state
  useEffect(() => {
    if (!current || !canManageLinks) return;
    // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change
    setLoading(true);
    // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change
    setError("");
    void Promise.all([
      loadServerSettings(),
      api.get(`/servers/${current.id}/setup-projection`).catch(() => null),
    ])
      .then(([settings, projectionResponse]) => {
        if (!settings) throw new Error("Server settings unavailable");
        const data = settings.onboardSettings;
        const nextOnboardingAgentId = data.onboardingAgentId || "";
        const nextAgentAllChannelGreetingEnabled = data.agentAllChannelGreetingEnabled !== false;
        setOnboardingAgentId(nextOnboardingAgentId);
        setAgentAllChannelGreetingEnabled(nextAgentAllChannelGreetingEnabled);
        setSavedOnboardingAgentId(nextOnboardingAgentId);
        setSavedAgentAllChannelGreetingEnabled(nextAgentAllChannelGreetingEnabled);
        setSetupProjection(projectionResponse?.data ?? null);
        setSaved(false);
      })
      .catch(() => {
        setError(formatMessage({ id: "settings.onboarding.failedLoad" }));
      })
      .finally(() => {
        setLoading(false);
      });
  }, [canManageLinks, current?.id, loadServerSettings]);
  // oxlint-enable react-hooks/exhaustive-deps

  const dirty =
    onboardingAgentId !== savedOnboardingAgentId
    || agentAllChannelGreetingEnabled !== savedAgentAllChannelGreetingEnabled;

  const handleSave = async () => {
    if (!current || !canManageLinks) return;
    setSaving(true);
    setSaved(false);
    setError("");
    try {
      await api.patch(`/servers/${current.id}/onboarding-settings`, {
        onboardingAgentId: onboardingAgentId || null,
        agentAllChannelGreetingEnabled,
      });
      await loadServerSettings({ force: true });
      setSavedOnboardingAgentId(onboardingAgentId);
      setSavedAgentAllChannelGreetingEnabled(agentAllChannelGreetingEnabled);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1500);
    } catch (err: any) {
      setError(err.response?.data?.error || formatMessage({ id: "settings.onboarding.failedSave" }));
    } finally {
      setSaving(false);
    }
  };

  const handleFinishSetup = async () => {
    if (!current || !isAdminOrOwner || reopeningSetup) return;
    setReopeningSetup(true);
    setError("");
    try {
      const { data } = await api.post(`/servers/${current.id}/setup-transition`, { action: "start" });
      setSetupProjection(data);
      // Tell the gate. Without this the server reopened setup and the only visible effect
      // was a navigation: the modal that was supposed to appear never heard about it.
      bumpServerSetupRevision();
      navigate(`/s/${current.slug}`);
    } catch (error: unknown) {
      const responseError = (error as { response?: { data?: { error?: unknown } } }).response?.data?.error;
      setError(typeof responseError === "string" ? responseError : formatMessage({ id: "settings.onboarding.reopenSetupFailed" }));
    } finally {
      setReopeningSetup(false);
    }
  };

  if (!canManageLinks) return null;

  return (
    <div className="mb-6">
      <SectionHeader
        className="mb-3"
        icon={<Bot size={16} />}
        label={formatMessage({ id: "settings.onboarding.sectionLabel" })}
      />

      <div className="border-2 border-black bg-white shadow-brutal-sm p-4">
        <div className="space-y-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0 pr-0 sm:pr-4">
              <div className="text-sm font-bold text-black">
                {formatMessage({ id: "settings.onboarding.humanAgentTitle" })}
              </div>
              <div className="mt-0.5 text-xs text-black/60">
                {formatMessage({ id: "settings.onboarding.humanAgentDescription" })}
              </div>
            </div>
            <div className="w-full sm:w-80 sm:shrink-0">
              <Select
                value={onboardingAgentId}
                onValueChange={(value) => {
                  if (value == null) return;
                  setOnboardingAgentId(value);
                  setSaved(false);
                }}
                disabled={!canManageLinks || saving || loading}
                items={onboardingAgentOptions}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder={formatMessage({ id: "settings.onboarding.agentPlaceholder" })} />
                  <SelectIcon />
                </SelectTrigger>
                <SelectContent>
                  <SelectList>
                    {renderSelectItems(onboardingAgentOptions)}
                  </SelectList>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0 pr-0 sm:pr-4">
              <div className="text-sm font-bold text-black">
                {formatMessage({ id: "settings.onboarding.greetingTitle" })}
              </div>
              <div className="mt-0.5 text-xs text-black/60">
                {formatMessage({ id: "settings.onboarding.greetingDescription" })}
              </div>
            </div>
            <div className="w-full sm:w-28 sm:shrink-0">
              <Select
                value={agentAllChannelGreetingEnabled ? "yes" : "no"}
                onValueChange={(value) => {
                  if (value == null) return;
                  setAgentAllChannelGreetingEnabled(value === "yes");
                  setSaved(false);
                }}
                disabled={!canManageLinks || saving || loading}
                items={agentGreetingOptions}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder={formatMessage({ id: "settings.onboarding.greetingPlaceholder" })} />
                  <SelectIcon />
                </SelectTrigger>
                <SelectContent>
                  <SelectList>
                    {renderSelectItems(agentGreetingOptions)}
                  </SelectList>
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>

        {error && (
          <Banner intent="warning" density="sm" className="mt-2 font-bold">
            {error}
          </Banner>
        )}

        <div className="mt-2 flex items-center justify-between">
          {!canManageLinks && (
            <div className="text-[11px] text-black/50">{formatMessage({ id: "settings.onboarding.adminOnly" })}</div>
          )}
          <button
            type="button"
            onClick={handleSave}
            disabled={!canManageLinks || !dirty || saving || loading}
            className="btn-brutal bg-brutal-pink px-3 py-1.5 text-xs disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving ? formatMessage({ id: "settings.common.saving" }) : saved ? formatMessage({ id: "settings.common.saved" }) : formatMessage({ id: "settings.common.save" })}
          </button>
        </div>

        {/* Who may see the setup flow is the SERVER's answer, in one place: a non-owner's
            projection comes back `surface: "none"`. Re-deriving it here from the client's own
            role would be a second opinion that can drift — hide it in one surface, leak it in
            another (@Jianwei's point). The projection alone decides. */}
        {setupProjection && setupProjection.phase !== "complete" && setupProjection.surface !== "none" ? (
          <div className="mt-4 flex items-center justify-between border-t-2 border-black pt-3">
            <div>
              <div className="text-xs font-bold">{formatMessage({ id: "settings.onboarding.serverSetupTitle" })}</div>
              <div className="text-[11px] text-black/50">{formatMessage({ id: "settings.onboarding.serverSetupDescription" })}</div>
            </div>
            <button
              type="button"
              onClick={() => void handleFinishSetup()}
              disabled={reopeningSetup}
              className="btn-brutal inline-flex items-center gap-1.5 bg-white px-3 py-1.5 text-xs disabled:opacity-50"
              data-testid="finish-server-setup"
            >
              {formatMessage({ id: reopeningSetup ? "settings.onboarding.openingSetup" : "settings.onboarding.finishSetup" })}
              {!reopeningSetup && <ChevronRight size={14} />}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function MemberPermissionsSection() {
  const { formatMessage } = useIntl();
  const server = useServerStore((s) => s.current);
  const updateServerProfile = useServerStore((s) => s.updateServerProfile);
  const { capabilities } = useServerPermissions();
  const canEdit = capabilities.editServerSettings;

  const [hideHumansFromMembers, setHideHumansFromMembers] = useState(server?.hideHumansFromMembers ?? false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  // Server-scoped form re-sync — same shape as L609/L616 / PR #2539 family.
  // oxlint-disable-next-line react-doctor/no-cascading-set-state
  useEffect(() => {
    // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change
    setHideHumansFromMembers(server?.hideHumansFromMembers ?? false);
    // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change
    setSaved(false);
    // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change
    setError("");
  }, [server?.id, server?.hideHumansFromMembers]);

  if (!server) return null;

  const dirty = hideHumansFromMembers !== server.hideHumansFromMembers;

  const handleSave = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setSaved(false);
    setError("");
    try {
      await updateServerProfile({ hideHumansFromMembers });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err: any) {
      setError(err.response?.data?.error || formatMessage({ id: "settings.memberPermissions.failedUpdate" }));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mb-6">
      <SectionHeader
        className="mb-3"
        icon={<Users size={16} />}
        label={formatMessage({ id: "settings.memberPermissions.sectionLabel" })}
      />

      <form onSubmit={handleSave} className="border-2 border-black bg-white shadow-brutal-sm p-4 space-y-3">
        <label className={`flex items-start gap-3 ${canEdit ? "" : "opacity-60"}`}>
          <Checkbox
            size="md"
            checked={hideHumansFromMembers}
            disabled={!canEdit || saving}
            onChange={(event) => setHideHumansFromMembers(event.currentTarget.checked)}
            className="mt-0.5"
          />
          <span className="min-w-0">
            <span className="block text-sm font-bold text-black">{formatMessage({ id: "settings.memberPermissions.hideHumansTitle" })}</span>
            <span className="block text-xs text-black/60 mt-0.5">
              {formatMessage({ id: "settings.memberPermissions.hideHumansDescription" })}
            </span>
          </span>
        </label>

        {error && (
          <Banner intent="warning" density="sm" className="font-bold">{error}</Banner>
        )}

        {canEdit && (
          <button
            type="submit"
            disabled={!dirty || saving}
            className="btn-brutal bg-brutal-pink px-3 py-1.5 text-xs flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving ? formatMessage({ id: "settings.common.saving" }) : saved ? (
              <><Check size={14} /> {formatMessage({ id: "settings.common.saved" })}</>
            ) : formatMessage({ id: "settings.common.save" })}
          </button>
        )}
      </form>
    </div>
  );
}

function SystemChannelsSection() {
  const { formatMessage } = useIntl();
  const { capabilities } = useServerPermissions();
  const channels = useChannelStore((s) => s.channels);
  const channelsLoading = useChannelStore((s) => s.loading);
  const restoreAllChannel = useChannelStore((s) => s.restoreAllChannel);
  const hideAllChannel = useChannelStore((s) => s.hideAllChannel);
  const allChannel = channels.find((channel) => channel.name === "all");
  const currentAllChannelHidden = !allChannel;
  const showSystemChannelSettings = capabilities.changeChannelVisibility && !channelsLoading;
  const [allChannelHidden, setAllChannelHidden] = useState(currentAllChannelHidden);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  // Settings-scoped re-sync for the virtual system #all state.
  // oxlint-disable-next-line react-doctor/no-derived-state-effect, react-doctor/no-cascading-set-state
  useEffect(() => {
    // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change
    setAllChannelHidden(currentAllChannelHidden);
    // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change
    setSaved(false);
    // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change
    setError("");
  }, [currentAllChannelHidden]);

  if (!showSystemChannelSettings) return null;

  const dirty = allChannelHidden !== currentAllChannelHidden;

  const handleSave = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    setSaved(false);
    setSaving(true);
    try {
      if (allChannelHidden) {
        // Previously went through the generic channel-visibility PATCH. The
        // server now refuses #all on that field; hiding has its own endpoint,
        // and it needs no channel id.
        await hideAllChannel();
      } else {
        await restoreAllChannel();
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err: any) {
      setError(err.response?.data?.error || formatMessage({ id: "settings.systemChannels.failedUpdate" }));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mb-6">
      <SectionHeader
        className="mb-3"
        icon={<Eye size={16} />}
        label={formatMessage({ id: "settings.systemChannels.sectionLabel" })}
      />

      <form onSubmit={handleSave} className="border-2 border-black bg-white shadow-brutal-sm p-4 space-y-3">
        <label className={`flex items-start gap-3 ${saving ? "opacity-60" : ""}`}>
          <Checkbox
            size="md"
            checked={allChannelHidden}
            disabled={saving}
            onChange={(event) => {
              setAllChannelHidden(event.currentTarget.checked);
              setSaved(false);
            }}
            className="mt-0.5"
          />
          <span className="min-w-0">
            <span className="block text-sm font-bold text-black">{formatMessage({ id: "settings.systemChannels.hideAllTitle" })}</span>
            <span className="block text-xs text-black/60 mt-0.5">
              {formatMessage({ id: "settings.systemChannels.hideAllDescription" })}
            </span>
          </span>
        </label>

        {error && (
          <Banner intent="warning" density="sm" className="font-bold">{error}</Banner>
        )}

        <button
          type="submit"
          disabled={!dirty || saving}
          className="btn-brutal bg-brutal-pink px-3 py-1.5 text-xs flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {saving ? formatMessage({ id: "settings.common.saving" }) : saved ? (
            <><Check size={14} /> {formatMessage({ id: "settings.common.saved" })}</>
          ) : formatMessage({ id: "settings.common.save" })}
        </button>
      </form>
    </div>
  );
}

function ServerTranslationSection() {
  const { formatMessage } = useIntl();
  const currentServer = useServerStore((s) => s.current);
  const settings = useTranslationStore((s) => s.settings);
  const settingsLoading = useTranslationStore((s) => s.settingsLoading);
  const settingsError = useTranslationStore((s) => s.settingsError);
  const loadSettings = useTranslationStore((s) => s.loadSettings);
  const updateServerTranslationEnabled = useTranslationStore((s) => s.updateServerTranslationEnabled);

  const [enabled, setEnabled] = useState(settings.serverTranslationEnabled);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    void loadSettings(currentServer?.id);
  }, [currentServer?.id, loadSettings]);

  // Settings-scoped re-sync (implicit server scope via settings store).
  // oxlint-disable-next-line react-doctor/no-cascading-set-state
  useEffect(() => {
    // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change
    setEnabled(settings.serverTranslationEnabled);
    // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change
    setSaved(false);
    // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change
    setError("");
  }, [settings.serverTranslationEnabled]);

  if (!currentServer) return null;

  const dirty = enabled !== settings.serverTranslationEnabled;
  const showProviderWarning = enabled && !settings.providerAvailable;

  const handleSave = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setSaved(false);
    setError("");
    try {
      await updateServerTranslationEnabled(enabled);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err: any) {
      setError(err.response?.data?.error || formatMessage({ id: "settings.serverTranslation.failedUpdate" }));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mb-6">
      <SectionHeader
        className="mb-3"
        icon={<Languages size={16} />}
        label={formatMessage({ id: "settings.serverTranslation.sectionLabel" })}
      />

      <form onSubmit={handleSave} className="border-2 border-black bg-white shadow-brutal-sm p-4 space-y-3">
        <label className={`flex items-start gap-3 ${settingsLoading || !settings.canManageServerTranslation ? "opacity-60" : ""}`}>
          <Checkbox
            size="md"
            checked={enabled}
            disabled={saving || settingsLoading || !settings.canManageServerTranslation}
            onChange={(event) => setEnabled(event.currentTarget.checked)}
            className="mt-0.5"
          />
          <span className="min-w-0">
            <span className="block text-sm font-bold text-black">{formatMessage({ id: "settings.serverTranslation.enableTitle" })}</span>
            <span className="block text-xs text-black/60 mt-0.5">
              {formatMessage({ id: "settings.serverTranslation.enableDescription" })}
            </span>
          </span>
        </label>

        {showProviderWarning && (
          <Banner intent="warning" density="sm" className="font-bold">
            {formatMessage({ id: "settings.serverTranslation.providerWarning" })}
          </Banner>
        )}

        {(settingsError || error) && (
          <Banner intent="warning" density="sm" className="font-bold">{error || settingsError}</Banner>
        )}

        {settings.canManageServerTranslation && (
          <button
            type="submit"
            disabled={!dirty || saving || settingsLoading}
            className="btn-brutal bg-brutal-pink px-3 py-1.5 text-xs flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving ? formatMessage({ id: "settings.common.saving" }) : saved ? (
              <><Check size={14} /> {formatMessage({ id: "settings.common.saved" })}</>
            ) : formatMessage({ id: "settings.common.save" })}
          </button>
        )}
      </form>
    </div>
  );
}

// ── Plan & Billing Section ──

function PlanBillingLoadingSection() {
  const { formatMessage } = useIntl();
  return (
    <div className="mb-6" aria-busy="true">
      <SectionHeader
        className="mb-3"
        icon={<CreditCard size={16} />}
        label={formatMessage({ id: "billing.planBilling" })}
      />
      <div className="mb-6 border-2 border-black bg-white shadow-brutal-sm">
        <div className="border-b-2 border-black bg-brutal-cream px-4 py-4">
          <Skeleton variant="line" className="mb-2 h-5 w-32" />
          <Skeleton variant="line" className="h-4 w-64 max-w-full" />
        </div>

        <div className="grid gap-4 p-4 lg:grid-cols-2">
          {[0, 1].map((column) => (
            <div key={column}>
              <Skeleton variant="line" className="mb-3 h-4 w-24" />
              <div className="space-y-3">
                {[0, 1, 2].map((row) => (
                  <div key={row} className="flex items-start gap-3">
                    <Skeleton variant="block" className="mt-0.5 h-4 w-4 border-2 border-black/20" />
                    <Skeleton variant="line" className={row === 2 ? "w-3/5" : row === 1 ? "w-4/5" : "w-full"} />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="border-t-2 border-black/10 px-4 py-4">
          <div className="grid gap-3 sm:grid-cols-2">
            {(["billing.seat", "billing.messageHistory", "billing.fileUploads"] as const).map((label) => (
              <div key={label} className="flex items-center justify-between gap-3">
                <span className="text-xs font-bold text-black/45">{formatMessage({ id: label })}</span>
                <Skeleton variant="line" className="w-20" />
              </div>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t-2 border-black/10 px-4 py-4">
          <Skeleton variant="block" className="h-8 w-28 border-2 border-black/20" />
          <Skeleton variant="block" className="h-8 w-44 border-2 border-black/20" />
        </div>
      </div>

      <SectionHeader
        className="mb-3"
        icon={<Plus size={16} />}
        label={formatMessage({ id: "billing.managePlan" })}
      />
      <div className="mb-6 grid gap-4 border-2 border-black bg-white p-4 shadow-brutal-sm lg:grid-cols-[minmax(0,1fr)_280px]">
        <div>
          <Skeleton variant="line" className="mb-3 h-4 w-56 max-w-full" />
          <div className="flex flex-wrap items-center gap-3">
            <Skeleton variant="block" className="h-8 w-24 border-2 border-black/20" />
            <Skeleton variant="line" className="w-48 max-w-full" />
          </div>
          <Skeleton variant="block" className="mt-4 h-8 w-32 border-2 border-black/20" />
        </div>

        <div className="border-2 border-black bg-brutal-cream p-4 shadow-brutal-sm">
          <Skeleton variant="line" className="mb-4 h-3 w-32" />
          <div className="space-y-3">
            {[0, 1, 2].map((row) => (
              <div key={row} className="flex items-center justify-between gap-3">
                <Skeleton variant="line" className="w-28" />
                <Skeleton variant="line" className="w-16" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function DowngradeWarningCard({ server, usage }: { server: { planDowngradedAt: string | null }; usage: { agents: number; machines: number; channels?: number } | null }) {
  const { formatMessage } = useIntl();
  if (!server.planDowngradedAt) return null;


  const downgradedAt = new Date(server.planDowngradedAt);
  const graceEnd = new Date(downgradedAt);
  graceEnd.setDate(graceEnd.getDate() + DOWNGRADE_GRACE_PERIOD_DAYS);
  const now = new Date();
  const graceExpired = now >= graceEnd;
  const daysLeft = graceExpired
    ? 0
    : Math.ceil((graceEnd.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

  const limits = getEffectiveLimits("free");
  const agentCount = usage?.agents ?? 0;
  const machineCount = usage?.machines ?? 0;
  const channelCount = usage?.channels ?? 0;
  const excessAgents = getFinitePlanLimitExcess(agentCount, limits.maxAgents);
  const excessMachines = getFinitePlanLimitExcess(machineCount, limits.maxMachines);
  const excessChannels = getFinitePlanLimitExcess(channelCount, limits.maxChannels);

  return (
    <div className="mb-4 border-2 border-black bg-brutal-orange/20 shadow-brutal-sm p-4">
      <div className="flex items-center gap-2 mb-2">
        <AlertTriangle size={16} className="text-black" />
        <span className="text-sm font-bold">
          {graceExpired ? formatMessage({ id: "billing.gracePeriodExpired" }) : formatMessage({ id: "billing.planDowngraded" })}
        </span>
      </div>
      {graceExpired ? (
        <p className="text-xs text-black/60 font-mono">
          {formatMessage({ id: "billing.theGracePeriodHasEndedExcessAgentsHaveBeenSt" })}
        </p>
      ) : (
        <>
                <p className="text-xs text-black/60 font-mono mb-2">
                  {formatMessage(
                    {
                      id: excessAgents === 0 && excessMachines === 0 && excessChannels === 0
                        ? "billing.graceAllWithinLimits"
                        : "billing.graceExcessWillStop",
                    },
                    { days: daysLeft, b: (chunks) => <span key="b" className="font-bold text-black">{chunks}</span> },
                  )}
                </p>
          {(excessAgents > 0 || excessMachines > 0 || excessChannels > 0) && (
            <div className="space-y-1">
              {excessAgents > 0 && (
                <div className="text-xs font-mono">
                  {formatMessage(
                      { id: "billing.agentsOverLimit" },
                      { count: excessAgents, b: (chunks) => <span key="b" className="font-bold text-brutal-orange">{chunks}</span> },
                    )} ({agentCount}/{limits.maxAgents})
                </div>
              )}
              {excessMachines > 0 && (
                <div className="text-xs font-mono">
                  {formatMessage(
                      { id: "billing.computersOverLimit" },
                      { count: excessMachines, b: (chunks) => <span key="b" className="font-bold text-brutal-orange">{chunks}</span> },
                    )} ({machineCount}/{limits.maxMachines})
                </div>
              )}
              {excessChannels > 0 && (
                <div className="text-xs font-mono">
                  {formatMessage(
                      { id: "billing.channelsOverLimit" },
                      { count: excessChannels, b: (chunks) => <span key="b" className="font-bold text-brutal-orange">{chunks}</span> },
                    )} ({channelCount}/{limits.maxChannels})
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

interface BillingSeatUpdatePreview {
  status: "preview";
  currentPackQuantity: number;
  requestedPackQuantity: number;
  currency: string;
  prorationAmount: number;
  recurringAmount: number;
  discountAmount: number;
  promotion: {
    code: string;
    name: string | null;
    percentOff: number | null;
    amountOff: number | null;
    currency: string | null;
  } | null;
  previewToken: string;
  expiresAt: string;
}

// Stryker disable all: Settings billing UI wiring is covered by billingSeatInput behavior tests, source-copy contracts, and visual preview screenshots.
export function PlanSection() {
  const { formatMessage, locale: intlLocale } = useIntl();
  const server = useServerStore((s) => s.current);
  const usage = useServerStore((s) => s.usage);
  const billing = useServerStore((s) => s.billing);
  const loadingUsage = useServerStore((s) => s.loadingUsage);
  const loadingBilling = useServerStore((s) => s.loadingBilling);
  const loadUsage = useServerStore((s) => s.loadUsage);
  const loadBilling = useServerStore((s) => s.loadBilling);
  const [billingAction, setBillingAction] = useState<"checkout" | "portal" | "preview" | "update" | "cancel" | null>(null);
  const [billingError, setBillingError] = useState("");
  const [billingNotice, setBillingNotice] = useState("");
  const [desiredSeatOverride, setDesiredSeatOverride] = useState<number | null>(null);
  const [desiredSeatInput, setDesiredSeatInput] = useState<string | null>(null);
  const [billingInterval, setBillingInterval] = useState<BillingInterval>(DEFAULT_BILLING_INTERVAL);
  const [showCancelSubscriptionConfirm, setShowCancelSubscriptionConfirm] = useState(false);
  const [confirmBillingAction, setConfirmBillingAction] = useState<"checkout" | "update" | null>(null);
  const [promotionCode, setPromotionCode] = useState("");
  const [seatUpdatePreview, setSeatUpdatePreview] = useState<BillingSeatUpdatePreview | null>(null);

  useEffect(() => {
    loadUsage();
    loadBilling();
  }, [loadBilling, loadUsage]);

  if (!server || loadingUsage || loadingBilling) {
    return <PlanBillingLoadingSection />;
  }

  const plan = (billing?.plan ?? server.plan) as ServerPlan;
  const config = PLAN_CONFIG[plan];
  const limits = getEffectiveLimits(plan);
  const pricedLimits = config.limits;
  const capacity = billing?.capacity;

  const agentCount = billing?.usage.agents ?? usage?.agents ?? 0;
  const humanCount = billing?.usage.humans;
  const usesUniversalSeats = capacity != null && capacity.maxUniversalSeats !== -1;
  const universalSeatLimit = usesUniversalSeats ? capacity?.maxUniversalSeats ?? 0 : 0;
  const usedHumanUniversalSeats = Math.max(0, humanCount ?? 0);
  const usedAgentUniversalSeats = Math.max(0, agentCount * PRO_AGENT_SEAT_FRACTION);
  const usedUniversalSeats = Math.max(
    0,
    billing?.usage.universalSeats ?? usedHumanUniversalSeats + usedAgentUniversalSeats,
  );
  const seatUsageScale = universalSeatLimit > 0 && usedUniversalSeats > universalSeatLimit
    ? universalSeatLimit / usedUniversalSeats
    : 1;
  const humanSeatUsagePercent = universalSeatLimit > 0
    ? Math.min(100, (usedHumanUniversalSeats * seatUsageScale / universalSeatLimit) * 100)
    : 0;
  const agentSeatUsagePercent = universalSeatLimit > 0
    ? Math.min(100, (usedAgentUniversalSeats * seatUsageScale / universalSeatLimit) * 100)
    : 0;
  const canManageBilling = billing?.permissions.canManageBilling === true;
  const billingControlsState = getBillingControlsState({
    plan: billing?.plan ?? server?.plan ?? null,
    subscriptionStatus: billing?.subscription?.status ?? null,
  });
  const isProPlan = plan === "pro";
  const showSeatUsage = isProPlan;
  const billingControlsDisabledReason = !canManageBilling
    ? formatMessage({ id: "billing.onlyServerOwnersCanChangeBilling" })
    : !billing?.stripeConfigured
      ? formatMessage({ id: "billing.paidPlansAreNotAvailableYet" })
      : null;
  const formatLimit = (value: number | undefined) => value == null
    ? "..."
    : value === -1 ? formatMessage({ id: "billing.unlimited" }) : String(value);
  const formatBytes = (value: number | undefined) => {
    if (value == null || value < 0) return formatMessage({ id: "billing.unlimited" });
    if (value >= 1024 * 1024) return `${Math.round(value / 1024 / 1024)} MB`;
    return `${Math.round(value / 1024)} KB`;
  };
  const formatSeatUsageNumber = (value: number) => value.toFixed(1).replace(/\.0$/, "");
  const finalTrialActive = isTrialActive();
  const formatUsd = (value: number) => Number.isInteger(value) ? String(value) : value.toFixed(2);
  const currentHumanSeats = billing?.provisioned.humans ?? 0;
  const currentAgentSeats = billing?.provisioned.agents ?? 0;
  const currentSeatQuantity = billing?.provisioned.proPackQuantity ?? 0;
  const minimumUsageSeatQuantity = Math.max(1, Math.ceil(usedUniversalSeats));
  const minimumSeatQuantity = isProPlan ? Math.max(1, currentSeatQuantity) : 1;
  const isCheckoutMode = billingControlsState.canCheckout;
  const isManageSeatMode = !isCheckoutMode && billingControlsState.canUpdatePacks && isProPlan;
  const showManagePlanSection = isCheckoutMode || billingControlsState.canUpdatePacks;
  const isCancelScheduled = billing?.subscription?.cancelAtPeriodEnd === true;
  const minimumManageSeatQuantity = Math.max(1, minimumUsageSeatQuantity);
  const defaultSeatInputQuantity = isManageSeatMode
    ? Math.max(minimumManageSeatQuantity, currentSeatQuantity)
    : Math.max(minimumUsageSeatQuantity, minimumSeatQuantity);
  const requestedSeatInputQuantity = desiredSeatOverride ?? defaultSeatInputQuantity;
  const draftRequestedSeatQuantity = requestedSeatInputQuantity;
  const billingSeatDraftState = getBillingSeatDraftState({
    requestedSeatQuantity: draftRequestedSeatQuantity,
    draftSeatQuantity: draftRequestedSeatQuantity,
    minimumUsageSeatQuantity,
    minimumSeatQuantity: isManageSeatMode ? 1 : minimumSeatQuantity,
  });
  const requestedSeatQuantity = billingSeatDraftState.requestedSeatQuantity;
  const draftSeatQuantity = billingSeatDraftState.draftSeatQuantity;
  const draftProvisionedAgentSeats = draftSeatQuantity * PRO_AGENT_SEAT_BLOCK_SIZE;
  const requestedHumanSeatCapacity = requestedSeatQuantity;
  const requestedAgentSeatCapacity = requestedSeatQuantity * PRO_AGENT_SEAT_BLOCK_SIZE;
  const draftBelowRequiredCoverage = billingSeatDraftState.belowCurrentUsage;
  const checkoutRequest = {
    targetPlan: "pro",
    billingInterval,
    seatQuantity: requestedSeatQuantity,
    humanSeatQuantity: requestedHumanSeatCapacity,
    agentSeatQuantity: requestedAgentSeatCapacity,
  };
  const managePlanTitle = isCheckoutMode
    ? formatMessage({ id: "billing.upgradeToPro" })
    : isManageSeatMode ? (formatMessage({ id: "billing.manageSeats" })) : formatMessage({ id: "billing.managePlan" });
  const currentBillingInterval = billing?.subscription?.billingInterval ?? billing?.price?.billingInterval ?? DEFAULT_BILLING_INTERVAL;
  const currentBillingIntervalLabel = currentBillingInterval === "annual" ? formatMessage({ id: "billing.yearly" }) : formatMessage({ id: "billing.monthly" });
  const currentTotalLabel = billing?.price
    ? getBillingCurrentTotalLabel(
      currentBillingInterval,
      billing.price.monthlyUsd,
      billing.price.annualUsd,
      formatUsd,
    )
    : null;
  const currentPlanPresentation = getSettingsBillingPlanPresentation(
    plan,
    config.displayName,
    currentHumanSeats,
    currentAgentSeats,
    currentSeatQuantity,
    formatProAgentSeatFraction(),
  );
  const currentPlanDisplayName = formatMessage({ id: currentPlanPresentation.displayName });
  const currentPlanDescription = formatMessage(
    { id: currentPlanPresentation.description },
    currentPlanPresentation.descriptionValues,
  );
  const pricedFileUploadLimitLabel = plan === "free" ? `${formatBytes(FREE_MONTHLY_FILE_UPLOAD_LIMIT_BYTES)}/${formatMessage({ id: "billing.month" })}` : formatMessage({ id: "billing.unlimited" });
  const comparePlansHref = "https://raft.build/#pricing";
  const currentIncludedFeatures = currentPlanPresentation.includedFeatures.map((id) => formatMessage({ id }));
  const currentNotIncludedFeatures = currentPlanPresentation.notIncludedFeatures.map((id) => formatMessage({ id }));
  const hasNotIncludedFeatures = currentNotIncludedFeatures.length > 0;
  const selectedTotalLabels = getBillingSelectedTotalLabels(
    isManageSeatMode ? currentBillingInterval : billingInterval,
    draftSeatQuantity,
    PRO_SEAT_MONTHLY_USD,
    PRO_SEAT_ANNUAL_USD,
    formatUsd,
  );
  // Priced totals arrive as {id, amount}; the "/ year" | "/ 年" period is part of
  // the translation now, so there is nothing left to patch after the fact.
  const formatPricedTotal = (total: BillingPricedTotal | null) =>
    total == null ? null : formatMessage({ id: total.id }, { amount: total.amount });
  const localizedSelectedTotalLabels = {
    totalLabel: formatPricedTotal(selectedTotalLabels.totalLabel)!,
    originalLabel: formatPricedTotal(selectedTotalLabels.originalLabel),
  };
  const localizedCurrentTotalLabel = formatPricedTotal(currentTotalLabel);
  const seatDelta = draftSeatQuantity - currentSeatQuantity;
  const additionalSeats = Math.max(0, seatDelta);
  const removedSeats = Math.max(0, -seatDelta);
  const normalizedPromotionCode = promotionCode.trim();
  const formatBillingAmount = (amount: number, currency: string) => new Intl.NumberFormat(
    intlLocale.toLowerCase().startsWith("zh") ? "zh-CN" : "en-US",
    { style: "currency", currency: currency.toUpperCase() },
  ).format(amount / 100);
  const formatSeatLabel = (count: number) => formatMessage({ id: "billing.seatCount" }, { count });
  const formatHumanCapacityLabel = (count: number) => formatMessage({ id: "billing.upToHumans" }, { count });
  const formatAgentCapacityLabel = (count: number) => formatMessage({ id: "billing.orAgents" }, { count });
  const handleSeatInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    applyBillingSeatInputChange(
      event.currentTarget.value,
      setDesiredSeatInput,
      setDesiredSeatOverride,
    );
  };
  // Stryker disable next-line BlockStatement: component wiring delegates to billingSeatInput helpers covered by DOM-gate behavior tests.
  const commitSeatInput = () => {
    applyBillingSeatInputCommit(
      desiredSeatInput,
      requestedSeatInputQuantity,
      isManageSeatMode ? minimumManageSeatQuantity : Math.max(minimumUsageSeatQuantity, minimumSeatQuantity),
      setDesiredSeatOverride,
      setDesiredSeatInput,
    );
  };
  const noSeatChangeSelected = requestedSeatQuantity === currentSeatQuantity;
  const updateSeatButtonDisabled = !!billingControlsDisabledReason
    || draftBelowRequiredCoverage
    || billingAction != null
    || (!isCancelScheduled && noSeatChangeSelected);
  const updateSeatButtonTitle = billingControlsDisabledReason
    ?? (draftBelowRequiredCoverage
      ? formatMessage({ id: "billing.keepAtLeastSeats" }, { min: minimumUsageSeatQuantity })
      : null)
    ?? (isCancelScheduled
      ? noSeatChangeSelected
        ? formatMessage({ id: "billing.reactivateThisProSubscriptionBeforeTheCurren" })
        : formatMessage({ id: "billing.reactivateThisSubscriptionAndUpdateSeats" })
      : noSeatChangeSelected
        ? formatMessage({ id: "billing.enterADifferentSeatTotal" })
      : formatMessage({ id: "billing.reviewProSeatUpdateBeforeConfirming" }));
  const updateSeatButtonLabel = isCancelScheduled
    ? noSeatChangeSelected ? formatMessage({ id: "billing.reactivateSubscription" }) : formatMessage({ id: "billing.reactivateAndUpdateSeats" })
    : formatMessage({ id: "billing.reviewSeatUpdate" });
  const updateSeatButtonBusyLabel = billingAction === "preview"
    ? formatMessage({ id: "billing.reviewing" })
    : isCancelScheduled && noSeatChangeSelected ? formatMessage({ id: "billing.reactivating" }) : formatMessage({ id: "billing.updating" });
  const capacityLabel = isManageSeatMode
    ? seatDelta > 0
      ? formatMessage({ id: "billing.addsSeats" }, { seats: formatSeatLabel(additionalSeats) })
      : seatDelta < 0
        ? formatMessage({ id: "billing.removesSeats" }, { seats: formatSeatLabel(removedSeats) })
        : formatMessage({ id: "billing.keepsCurrentSeats" })
    : formatMessage({ id: "billing.selectedSeats" }, { seats: formatSeatLabel(draftSeatQuantity) });
  const billingSeatCopyMode = isManageSeatMode ? "manageSeats" : "default";
  const billingSeatCopyLabels = getBillingSeatCopyLabels(billingSeatCopyMode);
  const billingTotalSummaryLabels = getBillingTotalSummaryLabels(
    billingSeatCopyMode,
    isManageSeatMode ? currentBillingInterval : billingInterval,
  );
  // The two `localized…Labels` objects used to hold a full parallel Chinese copy
  // of these label groups behind `locale === "zh-CN"`, so every label existed
  // twice and could drift independently. The ids carry both languages now, so
  // the branch is gone and there is only one place to change a label.
  // Format at this boundary so the ~11 consumers below keep receiving STRINGS.
  // Without this the ids typecheck perfectly and the UI renders the literal text
  // "billing.totalSeats" — the same trap as the plan-presentation change in
  // #5774: the type system proves every value is a valid id and says nothing
  // about whether the consumer formats it.
  const localizedBillingSeatCopyLabels = {
    seatQuantityLabel: formatMessage({ id: billingSeatCopyLabels.seatQuantityLabel }),
    seatSummaryLabel: formatMessage({ id: billingSeatCopyLabels.seatSummaryLabel }),
    billableSeatsSummaryLabel: formatMessage({ id: billingSeatCopyLabels.billableSeatsSummaryLabel }),
    capacitySummaryLabel: formatMessage({ id: billingSeatCopyLabels.capacitySummaryLabel }),
    quantityHelpLabel: formatMessage(
      { id: billingSeatCopyLabels.quantityHelpLabel },
      { capacity: capacityLabel },
    ),
  };
  const localizedBillingTotalSummaryLabels = {
    currentTotalLabel: billingTotalSummaryLabels.currentTotalLabel
      ? formatMessage({ id: billingTotalSummaryLabels.currentTotalLabel })
      : null,
    totalLabel: formatMessage({ id: billingTotalSummaryLabels.totalLabel }),
  };
  const billingSeatDraftError = draftBelowRequiredCoverage
    ? isManageSeatMode
      ? formatMessage({ id: "billing.keepAtLeastSeats" }, { min: minimumUsageSeatQuantity })
      : formatMessage({ id: "billing.enterAtLeastSeats" }, { min: minimumUsageSeatQuantity })
    : null;
  // Stryker disable next-line StringLiteral: validated by source-copy contracts and visual preview, not by the DOM mutation corpus.
  const managePlanInputPrompt = isCheckoutMode
    ? formatMessage({ id: "billing.enterTheNumberOfSeatsToBuy" })
    : formatMessage({ id: "billing.enterTheTotalSeatsAfterThisUpdate" });
  const seatInputValue = getBillingSeatInputValue(desiredSeatInput, requestedSeatInputQuantity);
  const seatSummaryValue = draftSeatQuantity;

  const handleCheckout = async () => {
    if (billingControlsDisabledReason || !billingControlsState.canCheckout) return;
    setBillingError("");
    setBillingNotice("");
    setBillingAction("checkout");
    try {
      const { data } = await api.post("/billing/checkout", {
        ...checkoutRequest,
        successUrl: window.location.href,
        cancelUrl: window.location.href,
      });
      window.location.href = data.url;
    } catch (err: any) {
      setBillingError(err.response?.data?.error || formatMessage({ id: "billing.failedToStartCheckout" }));
      setBillingAction(null);
    }
  };

  const handlePortal = async () => {
    if (billingControlsDisabledReason || !billingControlsState.canOpenPortal) return;
    setBillingError("");
    setBillingNotice("");
    setBillingAction("portal");
    try {
      const { data } = await api.post("/billing/portal", {
        returnUrl: window.location.href,
      });
      window.location.href = data.url;
    } catch (err: any) {
      setBillingError(err.response?.data?.error || formatMessage({ id: "billing.failedToOpenBillingPortal" }));
      setBillingAction(null);
    }
  };

  const handlePackQuantityUpdate = async () => {
    if (billingControlsDisabledReason || !billingControlsState.canUpdatePacks) return;
    setBillingError("");
    setBillingNotice("");
    setBillingAction("update");
    try {
      const { data } = await api.post("/billing/seat-pack-quantity", {
        seatQuantity: requestedSeatQuantity,
        humanSeatQuantity: requestedHumanSeatCapacity,
        agentSeatQuantity: requestedAgentSeatCapacity,
        ...(seatUpdatePreview ? { previewToken: seatUpdatePreview.previewToken } : {}),
      });
      if (data.status === "pending_payment") {
        setBillingNotice(formatMessage({ id: "billing.seatUpdateIsPendingStripePaymentConfirmation" }));
      } else if (data.status === "unchanged") {
        setBillingNotice(formatMessage({ id: "billing.seatQuantitiesAreAlreadyUpToDate" }));
      } else if (data.status === "reactivated") {
        setBillingNotice(formatMessage({ id: "billing.subscriptionReactivatedYourCurrentProSeatCap" }));
      } else if (data.status === "updated" || data.effectiveAt === "current") {
        setBillingNotice(formatMessage({ id: "billing.seatUpdateConfirmedCapacityHasBeenRefreshedFro" }));
      } else {
        setBillingNotice(formatMessage({ id: "billing.seatUpdateRequestedCapacityWillUpdateAfterStri" }));
      }
      await loadBilling();
      setDesiredSeatOverride(null);
      setDesiredSeatInput(null);
      setPromotionCode("");
      setSeatUpdatePreview(null);
    } catch (err: any) {
      setBillingError(err.response?.data?.error || formatMessage({ id: "billing.failedToUpdateSeats" }));
    } finally {
      setBillingAction(null);
    }
  };

  const handleCancelSubscription = async () => {
    if (billingControlsDisabledReason || !billingControlsState.canOpenPortal) return;
    setBillingError("");
    setBillingNotice("");
    setBillingAction("cancel");
    try {
      await api.post("/billing/cancel");
      await loadBilling();
      setBillingNotice(formatMessage({ id: "billing.subscriptionCancellationScheduledForTheEndOf" }));
      setShowCancelSubscriptionConfirm(false);
    } catch (err: any) {
      setBillingError(err.response?.data?.error || formatMessage({ id: "billing.failedToCancelSubscription" }));
    } finally {
      setBillingAction(null);
    }
  };

  const openCheckoutConfirm = () => {
    if (billingControlsDisabledReason || billingSeatDraftError || !billingControlsState.canCheckout) return;
    setConfirmBillingAction("checkout");
  };

  const openSeatUpdateConfirm = async () => {
    if (updateSeatButtonDisabled || !billingControlsState.canUpdatePacks) return;
    setBillingError("");
    setBillingNotice("");
    setSeatUpdatePreview(null);
    if (seatDelta <= 0 || !normalizedPromotionCode) {
      setConfirmBillingAction("update");
      return;
    }
    setBillingAction("preview");
    try {
      const { data } = await api.post<BillingSeatUpdatePreview>("/billing/seat-pack-quantity/preview", {
        seatQuantity: requestedSeatQuantity,
        humanSeatQuantity: requestedHumanSeatCapacity,
        agentSeatQuantity: requestedAgentSeatCapacity,
        promotionCode: normalizedPromotionCode,
      });
      setSeatUpdatePreview(data);
      setConfirmBillingAction("update");
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: { error?: string } } };
      setBillingError(axiosErr.response?.data?.error || formatMessage({ id: "billing.failedToPreviewSeatUpdate" }));
    } finally {
      setBillingAction(null);
    }
  };

  return (
    <div className="mb-6">
      <SectionHeader
        className="mb-3"
        icon={<CreditCard size={16} />}
        label={formatMessage({ id: "billing.currentPlan" })}
      />

      {/* Downgrade warning */}
      {server?.planDowngradedAt && (
        <DowngradeWarningCard server={server} usage={usage} />
      )}

      {/* Free trial notice */}
      {plan === "free" && finalTrialActive && (
        <div className="mb-4 border-2 border-black bg-soft-signal/30 shadow-brutal-sm p-4">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-sm font-bold">{formatMessage({ id: "billing.finalTrialPeriod" })}</span>
          </div>
          <p className="text-xs text-black/60 font-mono">
                  {formatMessage(
                    { id: "billing.trialActiveThrough" },
                    {
                      date: formatGlobalTrialCutoffDate(intlLocale),
                    },
                  )}
          </p>
        </div>
      )}

      <div className="mb-6 border-2 border-black bg-white shadow-brutal-sm">
        <div className="border-b-2 border-black bg-brutal-cream px-4 py-4">
          <div className="flex flex-wrap items-center gap-3">
            <div className="min-w-0">
              <div className="text-lg font-bold text-black">{currentPlanDisplayName}</div>
              <div className="text-sm text-black/60">
                {currentPlanDescription}
              </div>
            </div>
          </div>
        </div>

        <div className={`grid gap-4 p-4 ${hasNotIncludedFeatures ? "lg:grid-cols-2" : ""}`}>
          <div>
            <div className="mb-3 text-sm font-bold text-black">{formatMessage({ id: "billing.included" })}</div>
            <div className="space-y-3">
              {currentIncludedFeatures.map((feature) => (
                <div key={feature} className="flex items-start gap-3 text-sm text-black">
                  <Check size={16} className="mt-0.5 shrink-0 text-green-700" />
                  <span>{feature}</span>
                </div>
              ))}
            </div>
          </div>

          {hasNotIncludedFeatures && (
            <div>
              <div className="mb-3 text-sm font-bold text-black/60">{formatMessage({ id: "billing.notIncluded" })}</div>
              <div className="space-y-3">
                {currentNotIncludedFeatures.map((feature) => (
                  <div key={feature} className="flex items-start gap-3 text-sm text-black">
                    <X size={16} className="mt-0.5 shrink-0 text-brutal-red" />
                    <span>{feature}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="border-t-2 border-black/10 px-4 py-4">
          {showSeatUsage && usesUniversalSeats && (
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs font-bold text-black">{formatMessage({ id: "billing.seat" })}</span>
                <span className="text-xs font-mono text-black/60">
                  {formatSeatUsageNumber(usedUniversalSeats)} / {formatLimit(universalSeatLimit)} {formatMessage({ id: "billing.used" })}
                </span>
              </div>
              <div className="flex h-4 w-full overflow-hidden border-2 border-black bg-white">
                {humanSeatUsagePercent > 0 && (
                  <div
                    className="h-full bg-soft-signal"
                    style={{ width: `${humanSeatUsagePercent}%` }}
                    title={formatMessage(
                      { id: "billing.humansUsingSeats" },
                      {
                        people: humanCount ?? 0,
                        seatsText: formatSeatUsageNumber(usedHumanUniversalSeats),
                        seatCount: usedHumanUniversalSeats,
                      },
                    )}
                  />
                )}
                {agentSeatUsagePercent > 0 && (
                  <div
                    className="h-full bg-brutal-pink"
                    style={{ width: `${agentSeatUsagePercent}%` }}
                    title={formatMessage(
                      { id: "billing.agentsUsingSeats" },
                      {
                        people: agentCount,
                        seatsText: formatSeatUsageNumber(usedAgentUniversalSeats),
                        seatCount: usedAgentUniversalSeats,
                      },
                    )}
                  />
                )}
              </div>
              <div className="flex flex-wrap items-center gap-4 text-xs">
                <div className="flex items-center gap-2">
                  <span className="flex items-center gap-2 font-bold text-black">
                    <span className="size-2 border border-black bg-soft-signal" />
                    {formatMessage({ id: "billing.humans" })}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="flex items-center gap-2 font-bold text-black">
                    <span className="size-2 border border-black bg-brutal-pink" />
                    {formatMessage({ id: "billing.agents" })}
                  </span>
                </div>
              </div>
            </div>
          )}
          {showSeatUsage && !usesUniversalSeats && (
            <div className="grid gap-3 sm:grid-cols-2">
              {humanCount != null && (
                <div className="flex items-center justify-between gap-3">
                  <span className="text-xs font-bold text-black">{formatMessage({ id: "billing.humans" })}</span>
                  <span className="text-xs font-mono text-black/60">
                    {humanCount} / {formatLimit(capacity?.maxHumans)}
                  </span>
                </div>
              )}
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs font-bold text-black">{formatMessage({ id: "billing.agents" })}</span>
                <span className="text-xs font-mono text-black/60">
                  {agentCount} / {formatLimit(capacity?.maxAgents ?? limits.maxAgents)}
                </span>
              </div>
            </div>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            {plan === "free" && (
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs font-bold text-black">{formatMessage({ id: "billing.messageHistory" })}</span>
                <span className="text-xs font-mono text-black/60">
                  {pricedLimits.messageHistoryDays === -1 ? formatMessage({ id: "billing.unlimited" }) : `${pricedLimits.messageHistoryDays} ${formatMessage({ id: "billing.days" })}`}
                </span>
              </div>
            )}
            {plan === "free" && billing?.fileUploadQuota && (
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs font-bold text-black">{formatMessage({ id: "billing.fileUploads" })}</span>
                <span className="text-xs font-mono text-black/60">
                  {billing.fileUploadQuota.limited
                    ? `${formatBytes(billing.fileUploadQuota.usedBytes)} / ${formatBytes(billing.fileUploadQuota.limitBytes)} ${formatMessage({ id: "billing.thisMonth" })}`
                    : pricedFileUploadLimitLabel}
                </span>
              </div>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t-2 border-black/10 px-4 py-4">
          {billingControlsState.canOpenPortal ? (
            <div className="flex min-w-0 flex-wrap gap-2">
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className="btn-brutal-sm bg-white px-3 py-1.5 text-xs disabled:opacity-50"
                  disabled={!!billingControlsDisabledReason || billingAction != null}
                  onClick={handlePortal}
                  title={billingControlsDisabledReason ?? formatMessage({ id: "billing.openStripeBillingPortal" })}
                >
                  {billingAction === "portal" ? formatMessage({ id: "billing.opening" }) : formatMessage({ id: "billing.billingPortal" })}
                </button>
                {!isCancelScheduled && (
                  <button
                    type="button"
                    className="btn-brutal-sm bg-white px-3 py-1.5 text-xs disabled:opacity-50"
                    disabled={!!billingControlsDisabledReason || billingAction != null}
                    onClick={() => setShowCancelSubscriptionConfirm(true)}
                    title={billingControlsDisabledReason ?? formatMessage({ id: "billing.cancelTheWholeProSubscriptionAtPeriodEnd" })}
                  >
                    {formatMessage({ id: "billing.cancelSubscription2" })}
                  </button>
                )}
              </div>
            </div>
          ) : (
            <span />
          )}
          <a
            href={comparePlansHref}
            className="btn-brutal-sm cursor-default bg-white px-3 py-1.5 text-xs"
          >
            {formatMessage({ id: "billing.seeAllFeaturesAndComparePlans" })}
          </a>
        </div>
      </div>

      {showManagePlanSection && (
        <>
          <SectionHeader
            className="mb-3"
            icon={isCheckoutMode ? <CreditCard size={16} /> : <Plus size={16} />}
            label={managePlanTitle}
          />

          <div className="mb-6 grid gap-4 border-2 border-black bg-white p-4 shadow-brutal-sm lg:grid-cols-[minmax(0,1fr)_280px]">
            <div>
              {isCheckoutMode && (
                <div className="mb-4">
                  <div className="mb-2 text-sm font-bold text-black">{formatMessage({ id: "billing.howOftenDoYouWantToBeBilled" })}</div>
                  <BillingIntervalSegmentedControl
                    value={billingInterval}
                    onValueChange={setBillingInterval}
                    disabled={!!billingControlsDisabledReason || billingAction != null}
                  />
                </div>
              )}

              {billing?.subscription && (
                <div className="mb-4 text-xs font-mono text-black/60">
                  {formatMessage({ id: "billing.billingInterval" })}: {isCancelScheduled
                    ? formatMessage(
                        { id: "billing.intervalWithCancellationScheduled" },
                        { interval: currentBillingIntervalLabel },
                      )
                    : currentBillingIntervalLabel}
                </div>
              )}

              <div className="flex min-w-0 flex-col gap-3">
                <span className="text-sm font-bold text-black">
                  {managePlanInputPrompt}
                </span>
                <div className="flex flex-wrap items-end gap-3">
                  <label className="flex flex-col gap-1">
                    <span className="text-xs font-bold text-black/60">{localizedBillingSeatCopyLabels.seatQuantityLabel}</span>
                    <input
                      className="w-28 border-2 border-black bg-white px-2 py-1 text-sm font-mono"
                      type="text"
                      inputMode="numeric"
                      pattern="[0-9]*"
                      min={isManageSeatMode ? minimumManageSeatQuantity : Math.max(minimumUsageSeatQuantity, minimumSeatQuantity)}
                      step={1}
                      aria-label={localizedBillingSeatCopyLabels.seatQuantityLabel}
                      value={seatInputValue}
                      disabled={!!billingControlsDisabledReason || billingAction != null}
                      onChange={handleSeatInputChange}
                      onBlur={commitSeatInput}
                    />
                  </label>
                  {isManageSeatMode && seatDelta > 0 && (
                    <label className="flex w-64 max-w-full flex-col gap-1">
                      <span className="text-xs font-bold text-black/60">{formatMessage({ id: "billing.promotionCodeOptional" })}</span>
                      <input
                        className="w-full border-2 border-black bg-white px-2 py-1 text-sm font-mono uppercase"
                        type="text"
                        autoComplete="off"
                        aria-label={formatMessage({ id: "billing.promotionCodeOptional" })}
                        value={promotionCode}
                        disabled={!!billingControlsDisabledReason || billingAction != null}
                        onChange={(event) => {
                          setPromotionCode(event.currentTarget.value);
                          setSeatUpdatePreview(null);
                        }}
                      />
                    </label>
                  )}
                </div>
                {isManageSeatMode && seatDelta > 0 && (
                  <span className="text-[11px] font-mono text-black/50">
                    {formatMessage({ id: "billing.enterACodeApprovedForExistingSeatUpdate" })}
                  </span>
                )}
                <span className="text-xs font-mono text-black/60">
                    {localizedBillingSeatCopyLabels.quantityHelpLabel} {formatMessage(
                      { id: "billing.seatCoverageHelp" },
                      { min: minimumUsageSeatQuantity, price: PRO_SEAT_MONTHLY_USD },
                    )}
                </span>
                {billingSeatDraftError && (
                  <span className="text-xs font-mono text-brutal-red">
                    {billingSeatDraftError}
                  </span>
                )}
              </div>

              <div className="mt-4 flex flex-wrap gap-2">
                {isCheckoutMode && (
                  <button
                    type="button"
                    className="btn-brutal-sm bg-brutal-pink px-3 py-1.5 text-xs disabled:opacity-50"
                    disabled={!!billingControlsDisabledReason || !!billingSeatDraftError || billingAction != null}
                    onClick={openCheckoutConfirm}
                      title={billingControlsDisabledReason ?? billingSeatDraftError ?? formatMessage(
                        { id: "billing.startCheckoutTitle" },
                        {
                          interval: formatMessage({
                            id: billingInterval === "annual" ? "billing.yearly" : "billing.monthly",
                          }),
                          seats: requestedSeatQuantity,
                        },
                      )}
                  >
                    {billingAction === "checkout" ? formatMessage({ id: "billing.opening" }) : formatMessage({ id: "billing.upgradeToPro" })}
                  </button>
                )}
                {billingControlsState.canUpdatePacks && (
                  <button
                    type="button"
                    className="btn-brutal-sm bg-brutal-pink px-3 py-1.5 text-xs disabled:opacity-50"
                    disabled={updateSeatButtonDisabled}
                    onClick={openSeatUpdateConfirm}
                    title={updateSeatButtonTitle}
                  >
                    {billingAction === "update" || billingAction === "preview" ? updateSeatButtonBusyLabel : updateSeatButtonLabel}
                  </button>
                )}
              </div>
              {billingControlsDisabledReason && (
                <p className="mt-2 text-xs font-mono text-black/60">{billingControlsDisabledReason}</p>
              )}
              {billingNotice && (
                <p className="mt-2 text-xs font-mono text-black/60">{billingNotice}</p>
              )}
              {billingError && (
                <p className="mt-2 text-xs font-mono text-brutal-red">{billingError}</p>
              )}
            </div>

            <div className="border-2 border-black bg-brutal-cream p-4 shadow-brutal-sm">
              <div className="mb-3 text-xs font-bold uppercase tracking-widest text-black/50">
                {isCheckoutMode ? formatMessage({ id: "billing.checkoutSummary" }) : isManageSeatMode ? (formatMessage({ id: "billing.manageSeatsSummary" })) : formatMessage({ id: "billing.subscriptionSummary" })}
              </div>
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm font-bold text-black">{localizedBillingSeatCopyLabels.seatSummaryLabel}</span>
                  <span className="text-sm font-mono text-black/60">{seatSummaryValue}</span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm font-bold text-black">{localizedBillingSeatCopyLabels.billableSeatsSummaryLabel}</span>
                  <span className="text-sm font-mono text-black/60">{draftSeatQuantity}</span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm font-bold text-black">{localizedBillingSeatCopyLabels.capacitySummaryLabel}</span>
                  <span className="inline-flex flex-col items-end text-sm font-mono leading-5 text-black/60">
                    <span>{formatHumanCapacityLabel(draftSeatQuantity)}</span>
                    <span>{formatAgentCapacityLabel(draftProvisionedAgentSeats)}</span>
                  </span>
                </div>
                {isCheckoutMode ? (
                  <>
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm font-bold text-black">{localizedBillingTotalSummaryLabels.totalLabel}</span>
                      <span className="inline-flex flex-col items-end text-sm font-mono leading-5 text-black/60">
                        {localizedSelectedTotalLabels.originalLabel && (
                          <span className="text-black/40 line-through">{localizedSelectedTotalLabels.originalLabel}</span>
                        )}
                        <span>{localizedSelectedTotalLabels.totalLabel}</span>
                      </span>
                    </div>
                  </>
                ) : (
                  <>
                    {isManageSeatMode && (
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-sm font-bold text-black">{formatMessage({ id: "billing.currentSeats" })}</span>
                        <span className="text-sm font-mono text-black/60">{currentSeatQuantity}</span>
                      </div>
                    )}
                    {isManageSeatMode && seatDelta !== 0 && (
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-sm font-bold text-black">{seatDelta > 0 ? formatMessage({ id: "billing.addedCapacity" }) : formatMessage({ id: "billing.removedCapacity" })}</span>
                        <span className="inline-flex flex-col items-end text-sm font-mono leading-5 text-black/60">
                          <span>{formatHumanCapacityLabel(Math.abs(seatDelta))}</span>
                          <span>{formatAgentCapacityLabel(Math.abs(seatDelta) * PRO_AGENT_SEAT_BLOCK_SIZE)}</span>
                        </span>
                      </div>
                    )}
                    {isManageSeatMode && localizedCurrentTotalLabel && localizedBillingTotalSummaryLabels.currentTotalLabel && (
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-sm font-bold text-black">{localizedBillingTotalSummaryLabels.currentTotalLabel}</span>
                        <span className="text-sm font-mono text-black/60">{localizedCurrentTotalLabel}</span>
                      </div>
                    )}
                    {isManageSeatMode && (
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-sm font-bold text-black">{localizedBillingTotalSummaryLabels.totalLabel}</span>
                        <span className="inline-flex flex-col items-end text-sm font-mono leading-5 text-black/60">
                          {localizedSelectedTotalLabels.originalLabel && (
                            <span className="text-black/40 line-through">{localizedSelectedTotalLabels.originalLabel}</span>
                          )}
                          <span>{localizedSelectedTotalLabels.totalLabel}</span>
                        </span>
                      </div>
                    )}
                    <div className="border-t-2 border-black pt-3 text-xs font-mono text-black/60">
                      {formatMessage({ id: "billing.seatIncreasesMayBillImmediatelyAfterStripeConf" })}
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        </>
      )}

      {showCancelSubscriptionConfirm && (
        <ConfirmDialog
          chromeLocale="active"
          title={formatMessage({ id: "billing.cancelSubscription" })}
          message={formatMessage({ id: "billing.cancelTheWholeProSubscriptionAtTheEndOfTheCu" })}
          confirmLabel={formatMessage({ id: "billing.cancelSubscription2" })}
          loadingLabel={formatMessage({ id: "billing.canceling" })}
          confirmColor="bg-brutal-orange"
          onConfirm={handleCancelSubscription}
          onClose={() => setShowCancelSubscriptionConfirm(false)}
        />
      )}
      {/* Stryker restore all: the real PlanSection composition test owns this complete dialog boundary. */}
      {confirmBillingAction && (
        <ConfirmDialog
          chromeLocale="active"
          title={confirmBillingAction === "checkout"
            ? formatMessage({ id: "billing.confirmProCheckout" })
            : formatMessage({ id: "billing.confirmSeatUpdate" })}
          message={(
            <div className="space-y-2">
              <p>
                {confirmBillingAction === "checkout"
                  ? formatMessage({ id: "billing.youAreAboutToStartProCheckout" })
                  : formatMessage({ id: "billing.youAreAboutToUpdateThisProSubscription" })}
              </p>
              <div className="font-mono text-xs">
                {confirmBillingAction === "update" ? (
                  <>
                    <div>{formatMessage({ id: "billing.currentSeats" })}: {currentSeatQuantity}</div>
                    {seatDelta > 0 && <div>{formatMessage({ id: "billing.seatsToAdd" })}: {additionalSeats}</div>}
                    {seatDelta < 0 && <div>{formatMessage({ id: "billing.seatsToRemove" })}: {removedSeats}</div>}
                    <div>{formatMessage({ id: "billing.totalSeatsAfterUpdate" })}: {draftSeatQuantity}</div>
                    <div>{formatMessage({ id: "billing.capacityAfterUpdate" })}: {formatMessage(
                        { id: "billing.capacityPair" },
                        {
                          human: formatHumanCapacityLabel(draftSeatQuantity),
                          agent: formatAgentCapacityLabel(draftProvisionedAgentSeats),
                        },
                      )}</div>
                    {seatUpdatePreview && (
                      <>
                        {seatUpdatePreview.promotion && (
                          <div>{formatMessage({ id: "billing.appliedPromotion" })}: {seatUpdatePreview.promotion.code}</div>
                        )}
                        <div>{formatMessage({ id: "billing.estimatedProratedCharge" })}: {formatBillingAmount(seatUpdatePreview.prorationAmount, seatUpdatePreview.currency)}</div>
                        {seatUpdatePreview.discountAmount > 0 && (
                          <div>{formatMessage({ id: "billing.discount" })}: {formatBillingAmount(-seatUpdatePreview.discountAmount, seatUpdatePreview.currency)}</div>
                        )}
                        <div>
                          {currentBillingInterval === "annual" ? formatMessage({ id: "billing.estimatedNextYearlyTotal" }) : formatMessage({ id: "billing.estimatedNextMonthlyTotal" })}: {formatBillingAmount(seatUpdatePreview.recurringAmount, seatUpdatePreview.currency)}
                        </div>
                      </>
                    )}
                  </>
                ) : (
                  <>
                    <div>{formatMessage({ id: "billing.seats" })}: {draftSeatQuantity}</div>
                    <div>{formatMessage({ id: "billing.capacity" })}: {formatMessage(
                        { id: "billing.capacityPair" },
                        {
                          human: formatHumanCapacityLabel(draftSeatQuantity),
                          agent: formatAgentCapacityLabel(draftProvisionedAgentSeats),
                        },
                      )}</div>
                  </>
                )}
                <div>{localizedBillingTotalSummaryLabels.totalLabel}: {localizedSelectedTotalLabels.totalLabel}</div>
              </div>
              <p>
                {confirmBillingAction === "checkout"
                  ? formatMessage({ id: "billing.theNextPageIsStripeCheckoutWhereThePaymentAmou" })
                  : seatDelta > 0
                    ? formatMessage({ id: "billing.stripeMayBillThisSeatIncreaseImmediatelyAfterY" })
                    : seatDelta < 0
                      ? formatMessage({ id: "billing.stripeWillUpdateTheSubscriptionQuantityAfterYo" })
                      : formatMessage({ id: "billing.stripeWillReactivateThisSubscriptionWithoutCha" })}
              </p>
              {seatUpdatePreview && (
                <p>{formatMessage({ id: "billing.thisStripeEstimateExpiresAfter5MinutesRe" })}</p>
              )}
            </div>
          )}
          confirmLabel={confirmBillingAction === "checkout"
            ? formatMessage({ id: "billing.continueToStripe" })
            : formatMessage({ id: "billing.confirmAndUpdateSeats" })}
          loadingLabel={confirmBillingAction === "checkout"
            ? formatMessage({ id: "billing.opening2" })
            : formatMessage({ id: "billing.updating2" })}
          confirmColor="bg-brutal-pink"
          onConfirm={confirmBillingAction === "checkout" ? handleCheckout : handlePackQuantityUpdate}
          onClose={() => {
            setConfirmBillingAction(null);
            setSeatUpdatePreview(null);
          }}
        />
      )}
      {/* Stryker disable all: remaining billing wiring is covered by the broader billing contract suite. */}
    </div>
  );
}
// Stryker restore all

// ── Danger Zone Section ──
// Owner sees Delete Server (destructive).
// Admin/member see Leave Server (non-destructive, warning level).

function DangerActionCard({
  title,
  description,
  actionLabel,
  actionIcon,
  onAction,
  actionSize = "md",
  testId,
  actionTestId,
}: {
  title: string;
  description: string;
  actionLabel: string;
  actionIcon: ReactNode;
  onAction: () => void;
  actionSize?: "sm" | "md";
  testId: string;
  actionTestId?: string;
}) {
  return (
    <div data-testid={testId} className="border-2 border-black bg-white p-4 shadow-brutal-sm">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="text-sm font-bold text-black">{title}</div>
          <p className="mt-0.5 text-xs text-black/60">{description}</p>
        </div>
        <Button
          type="button"
          size={actionSize}
          shape="iconText"
          tone="red"
          onClick={onAction}
          className="sm:ml-4"
          data-testid={actionTestId}
        >
          {actionIcon}
          {actionLabel}
        </Button>
      </div>
    </div>
  );
}

function DangerZoneSection() {
  const { formatMessage } = useIntl();
  const server = useServerStore((s) => s.current);
  const deleteServer = useServerStore((s) => s.deleteServer);
  const leaveServer = useServerStore((s) => s.leaveServer);
  const { isOwner, role } = useServerPermissions();

  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [confirmSlug, setConfirmSlug] = useState("");

  const [showLeaveConfirm, setShowLeaveConfirm] = useState(false);

  if (!server) return null;
  const canLeave = role === "admin" || role === "member" || role === "guest";

  const handleDelete = async () => {
    requestServerSelection();
    await deleteServer();
  };

  const handleCloseDelete = () => {
    setShowDeleteConfirm(false);
    setConfirmSlug("");
  };

  return (
    <div className="mb-6">
      <SectionHeader
        className="mb-3"
        icon={<AlertTriangle size={16} />}
        label={formatMessage({ id: "settings.dangerZone.sectionLabel" })}
      />

      {canLeave && (
        <div className="border-2 border-black bg-white shadow-brutal-sm p-4 mb-3">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-bold text-black">{formatMessage({ id: "settings.dangerZone.leaveServerTitle" })}</div>
              <p className="text-xs text-black/60 mt-0.5">
                {formatMessage({ id: "settings.dangerZone.leaveServerDescription" })}
              </p>
            </div>
            <button
              data-testid="server-danger-leave-button"
              onClick={() => setShowLeaveConfirm(true)}
              className="btn-brutal bg-brutal-orange px-4 py-2 [@media(max-height:600px)]:py-1 text-sm font-bold flex items-center gap-1.5 shrink-0 ml-4"
            >
              {formatMessage({ id: "settings.dangerZone.leaveServer" })}
            </button>
          </div>
        </div>
      )}

      {isOwner && (
        <DangerActionCard
          testId="server-danger-delete-card"
          actionTestId="server-danger-delete-button"
          title={formatMessage({ id: "settings.dangerZone.deleteServerTitle" })}
          description={formatMessage({ id: "settings.dangerZone.deleteServerDescription" })}
          actionLabel={formatMessage({ id: "settings.dangerZone.deleteServer" })}
          actionIcon={<Trash2 size={14} />}
          onAction={() => setShowDeleteConfirm(true)}
        />
      )}

      {showLeaveConfirm && (
        <ConfirmDialog
          chromeLocale="active"
          title={formatMessage({ id: "settings.dangerZone.leaveServerTitle" })}
          message={formatMessage({ id: "settings.dangerZone.leaveConfirmMessage" }, { serverName: server.name })}
          confirmLabel={formatMessage({ id: "settings.dangerZone.leaveServer" })}
          loadingLabel={formatMessage({ id: "settings.dangerZone.leaving" })}
          confirmColor="bg-brutal-orange"
          confirmTestId="server-leave-confirm-button"
          onConfirm={async () => {
            requestServerSelection();
            await leaveServer();
          }}
          onClose={() => setShowLeaveConfirm(false)}
        />
      )}

      {showDeleteConfirm && (
        <ConfirmDialog
          chromeLocale="active"
          title={formatMessage({ id: "settings.dangerZone.deleteServerTitle" })}
          message={(
            <div className="space-y-4">
              <p>
                {formatMessage({ id: "settings.dangerZone.deleteWarningPrefix" })}<span className="font-bold">{server.name}</span>{formatMessage({ id: "settings.dangerZone.deleteWarningSuffix" })}
              </p>
              <div>
                <p className="text-sm text-black/60 mb-2">
                  {formatMessage({ id: "settings.dangerZone.typeToConfirmPrefix" })}<span className="font-mono font-bold text-black">{server.slug}</span>{formatMessage({ id: "settings.dangerZone.typeToConfirmSuffix" })}
                </p>
                <SlugInput
                  data-testid="server-delete-slug-input"
                  type="text"
                  value={confirmSlug}
                  onChange={(e) => setConfirmSlug(e.target.value)}
                  inputClassName="text-sm font-mono"
                  placeholder={server.slug}
                  autoFocus
                />
              </div>
            </div>
          )}
          confirmLabel={formatMessage({ id: "settings.dangerZone.deleteServer" })}
          loadingLabel={formatMessage({ id: "settings.dangerZone.deleting" })}
          confirmDisabled={confirmSlug !== server.slug}
          confirmTestId="server-delete-confirm-button"
          onConfirm={handleDelete}
          onClose={handleCloseDelete}
        />
      )}
    </div>
  );
}

export type ConnectedAppStatus = "private" | "publish_requested" | "in_review" | "published" | "rejected" | "unpublish_requested";
type ConnectedAppsViewMode = "grid" | "list";

const CONNECTED_APPS_VIEW_MODE_STORAGE_KEY = "raft:connected-apps:view-mode";
const CONNECTED_APP_EDITOR_SECTION_IDS = ["profile", "login", "notifications", "distribution", "danger"] as const;
type ConnectedAppEditorSectionId = typeof CONNECTED_APP_EDITOR_SECTION_IDS[number];

function canEditSourceOwnedConnectedApp(status: ConnectedAppStatus) {
  return status === "private" || status === "publish_requested" || status === "in_review" || status === "published" || status === "rejected";
}

function canDeleteSourceOwnedConnectedApp(status: ConnectedAppStatus) {
  return status === "private" || status === "publish_requested" || status === "in_review" || status === "rejected";
}

function canRequestOfflineSourceOwnedConnectedApp(status: ConnectedAppStatus) {
  return status === "published";
}

export function sourceOwnedConnectedAppStatusHint(status: ConnectedAppStatus): MessageId | null {
  if (status === "publish_requested" || status === "in_review") {
    return "settings.connectedApps.editor.statusHint.reviewPending";
  }
  if (status === "unpublish_requested") {
    return "settings.connectedApps.editor.statusHint.offlinePending";
  }
  return null;
}

// Returns a catalog id, not display text: keeps the helper pure and lets the
// MessageId type prove every arm resolves to a real entry. Callers formatMessage.
export function connectedAppOverviewDistributionLabel(status: ConnectedAppStatus): MessageId {
  if (status === "publish_requested" || status === "in_review") return "settings.connectedApps.editor.distribution.reviewPending";
  if (status === "unpublish_requested") return "settings.connectedApps.editor.distribution.offlineRequested";
  if (status === "published") return "settings.connectedApps.editor.distribution.published";
  if (status === "rejected") return "settings.connectedApps.editor.distribution.rejected";
  return "settings.connectedApps.editor.distribution.private";
}

export function connectedAppDistributionStatus(status: ConnectedAppStatus | null): MessageId {
  if (!status) return "settings.connectedApps.editor.distribution.availableAfterSave";
  if (status === "publish_requested" || status === "in_review") return "settings.connectedApps.editor.distribution.reviewPending";
  if (status === "unpublish_requested") return "settings.connectedApps.editor.distribution.offlinePending";
  if (status === "published") return "settings.connectedApps.editor.distribution.published";
  if (status === "rejected") return "settings.connectedApps.editor.distribution.rejected";
  return "settings.connectedApps.editor.distribution.private";
}

// Exported for settingsSubBatchF.i18n.behavior.test.tsx — presentational, so the
// zh tooth renders the real component with no API/data harness.
export function ConnectedAppDistributionBadge({ status }: { status: ConnectedAppStatus | null }) {
  // useIntl() must stay above the early return — hooks cannot be conditional.
  const { formatMessage } = useIntl();
  if (!status) return null;
  const label = formatMessage({ id: connectedAppOverviewDistributionLabel(status) });
  if (status === "published") return <Badge variant="success" uppercase>{label}</Badge>;
  if (status === "publish_requested" || status === "in_review" || status === "unpublish_requested" || status === "rejected") {
    return <Badge variant="warning" uppercase>{label}</Badge>;
  }
  return <Badge appearance="outline" uppercase>{label}</Badge>;
}

function getInitialConnectedAppsViewMode(): ConnectedAppsViewMode {
  if (typeof window === "undefined") return "grid";
  try {
    return window.localStorage.getItem(CONNECTED_APPS_VIEW_MODE_STORAGE_KEY) === "list" ? "list" : "grid";
  } catch {
    return "grid";
  }
}

function ConnectedAppsViewToggle({
  value,
  onValueChange,
}: {
  value: ConnectedAppsViewMode;
  onValueChange: (value: ConnectedAppsViewMode) => void;
}) {
  const { formatMessage } = useIntl();
  const gridLabel = formatMessage({ id: "settings.connectedApps.gridView" });
  const listLabel = formatMessage({ id: "settings.connectedApps.listView" });
  return (
    <div
      className="box-border flex h-10 min-h-10 shrink-0 items-stretch border-2 border-black bg-white shadow-brutal-sm"
      role="group"
      aria-label={formatMessage({ id: "settings.connectedApps.viewMode" })}
      data-testid="connected-apps-view-toggle"
    >
      <button
        type="button"
        onClick={() => onValueChange("grid")}
        aria-label={gridLabel}
        title={gridLabel}
        aria-pressed={value === "grid"}
        className={`flex w-10 items-center justify-center border-r-2 border-black transition-colors ${value === "grid" ? "bg-soft-signal" : "bg-white hover:bg-brutal-cream"}`}
      >
        <LayoutGrid size={16} />
      </button>
      <button
        type="button"
        onClick={() => onValueChange("list")}
        aria-label={listLabel}
        title={listLabel}
        aria-pressed={value === "list"}
        className={`flex w-10 items-center justify-center transition-colors ${value === "list" ? "bg-soft-signal" : "bg-white hover:bg-brutal-cream"}`}
      >
        <List size={17} />
      </button>
    </div>
  );
}

function connectedAppsCollectionClassName(viewMode: ConnectedAppsViewMode) {
  return viewMode === "grid" ? "grid gap-3 md:grid-cols-2" : "space-y-2";
}

function AppNotificationsLabel() {
  const { formatMessage } = useIntl();
  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-1.5">
      <span>{formatMessage({ id: "settings.connectedApps.section.appNotifications" })}</span>
      <Badge.Experimental />
    </span>
  );
}

function AppNotificationsEditorRailLabel() {
  const { formatMessage } = useIntl();
  return <span>{formatMessage({ id: "settings.connectedApps.section.appNotifications" })}</span>;
}

function ConnectedAppEditorSection({
  sectionId,
  title,
  description,
  status,
  tone = "default",
  children,
}: {
  sectionId: ConnectedAppEditorSectionId;
  title: ReactNode;
  description: string;
  status: string;
  tone?: "default" | "warning";
  children: ReactNode;
}) {
  return (
    <section
      id={`connected-app-editor-${sectionId}`}
      data-testid={`connected-app-editor-section-${sectionId}`}
      className={`scroll-mt-4 border-2 border-black ${tone === "warning" ? "bg-brutal-pink/15" : "bg-brutal-cream/35"}`}
    >
      <div className="flex flex-col gap-2 border-b-2 border-black bg-brutal-cream px-4 py-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h3 className="flex flex-wrap items-center gap-2 text-base font-black text-black">{title}</h3>
          <p className="mt-0.5 text-xs leading-relaxed text-black/60">{description}</p>
        </div>
        <span className="w-fit shrink-0 border-2 border-black bg-white px-2 py-1 font-mono text-[10px] font-black uppercase text-black">
          {status}
        </span>
      </div>
      <div className="space-y-4 bg-white p-4">{children}</div>
    </section>
  );
}

type ConnectedAppCategory = OAuthClientCategory;

type ConnectedAppListing = {
  id: string;
  clientId: string;
  name: string;
  category: ConnectedAppCategory;
  developer: string;
  description: string;
  homepageUrl: string | null;
  homepageDomain: string;
  callbackDomain: string;
  logoUrl: string | null;
  defaultLogoSeed: string;
  installed: boolean;
  marketplaceInstallBadge: MarketplaceInstallBadge;
  allowedScopes: string[] | null;
  appNotificationGroups: AppNotificationSelection["groups"];
  appNotificationEvents: AppNotificationSelection["events"];
  appNotificationReviewPending: boolean;
};

type BuiltInConnectedApp = {
  id: string;
  clientId: string;
  name: string;
  description: string | null;
  homepageUrl: string | null;
  homepageDomain: string | null;
  agentManifestUrl: string | null;
  logoUrl: string | null;
  defaultLogoSeed: string;
  allowedScopes: string[] | null;
};

type InstalledConnectedApp = {
  id: string;
  clientId: string;
  name: string;
  developer: string;
  description: string | null;
  homepageUrl: string | null;
  homepageDomain: string | null;
  callbackDomain: string | null;
  logoUrl: string | null;
  defaultLogoSeed: string;
  origin: "marketplace" | "private";
  privateShared: boolean;
  editable: boolean;
  allowedScopes: string[] | null;
  grantedScopes: string[];
  sourceClientId?: string;
  category: ConnectedAppCategory;
  publishStatus: ConnectedAppStatus | null;
};

// Exported for settingsSubBatchD.i18n.behavior.test.tsx — pure presentational,
// so the zh teeth render the real component with no API/data harness.
export function ConnectedAppOriginBadges({ app, className = "" }: { app: InstalledConnectedApp; className?: string }) {
  // useIntl() must stay above the early return — hooks cannot be conditional.
  const { formatMessage } = useIntl();
  if (!app.privateShared && app.origin !== "private") return null;
  return (
    <div className={`flex flex-wrap items-center gap-1.5 ${className}`.trim()}>
      {app.privateShared ? <Badge appearance="outline" uppercase>{formatMessage({ id: "settings.connectedApps.sharedBadge" })}</Badge> : null}
      {app.origin === "private" ? <Badge variant="success" uppercase>{formatMessage({ id: "settings.connectedApps.thisServerBadge" })}</Badge> : null}
    </div>
  );
}

type ServerRegisteredApp = OAuthClientRecord & {
  status: ConnectedAppStatus;
  logoUrl: string | null;
  defaultLogoSeed: string;
};

const CONNECTED_APP_CATEGORY_OPTIONS: { value: ConnectedAppCategory | "all" }[] = [
  { value: "all" },
  ...OAUTH_CLIENT_CATEGORIES.map((value) => ({ value })),
];
const CONNECTED_APP_PUBLISH_CATEGORY_OPTIONS = OAUTH_CLIENT_CATEGORIES.map((value) => ({ value }));

// Category enum values are data; the display labels live in the catalog.
const CONNECTED_APP_CATEGORY_LABEL_ID: Record<string, MessageId> = {
  all: "settings.connectedApps.categoryAll",
  "AI & Automation": "settings.connectedApps.categoryAiAutomation",
  Communication: "settings.connectedApps.categoryCommunication",
  "Productivity & Collaboration": "settings.connectedApps.categoryProductivity",
  "Developer Tools": "settings.connectedApps.categoryDeveloperTools",
  "Data & Analytics": "settings.connectedApps.categoryDataAnalytics",
  "Business Ops": "settings.connectedApps.categoryBusinessOps",
  Infrastructure: "settings.connectedApps.categoryInfrastructure",
  "Content & Creative": "settings.connectedApps.categoryContentCreative",
  Other: "settings.connectedApps.categoryOther",
};

export function matchesConnectedAppFilter(
  app: { name: string; category: ConnectedAppCategory; description?: string | null; developer?: string | null; clientId?: string | null },
  normalizedSearch: string,
  category: ConnectedAppCategory | "all",
) {
  if (category !== "all" && app.category !== category) return false;
  if (!normalizedSearch) return true;
  return [app.name, app.description, app.developer, app.clientId]
    .some((value) => value?.toLowerCase().includes(normalizedSearch));
}

function getDomainFromUrl(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  try {
    return new URL(trimmed).hostname;
  } catch {
    return trimmed;
  }
}

function initialsForApp(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.length >= 2
    ? `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}`
    : (parts[0] ?? "A").slice(0, 2);
  return letters.toUpperCase() || "A";
}

function ConnectedAppSummary({ description }: { description?: string | null }) {
  const text = description?.trim();
  if (!text) return null;
  return (
    <div className="mt-1 line-clamp-2 break-words text-sm leading-snug text-black/65" title={text}>
      {text}
    </div>
  );
}

const MARKETPLACE_INSTALL_BUCKET_LABEL: Record<Extract<MarketplaceInstallBadge, { kind: "bucket" }>["bucket"], string> = {
  "10_plus": "10+",
  "100_plus": "100+",
  "1k_plus": "1k+",
};

export function ConnectedAppMarketplaceInstallBadge({ badge }: { badge: MarketplaceInstallBadge }) {
  const { formatMessage } = useIntl();
  if (badge.kind === "none") return null;
  if (badge.kind === "new") {
    return <Badge variant="warning" uppercase>{formatMessage({ id: "settings.connectedApps.marketplaceNew" })}</Badge>;
  }
  return (
    <Badge appearance="outline" uppercase={false}>
      {formatMessage(
        { id: "settings.connectedApps.marketplaceInstallCount" },
        { count: MARKETPLACE_INSTALL_BUCKET_LABEL[badge.bucket] },
      )}
    </Badge>
  );
}

function ConnectedAppLogo({ name, logoUrl, seed, size = "md" }: { name: string; logoUrl?: string | null; seed: string; size?: "sm" | "md" | "lg" }) {
  return (
    <AvatarSlot
      context={size === "lg" ? "account-tile" : size === "md" ? "mention-card" : "surface-list"}
      type="app"
      appAvatarUrl={logoUrl}
      appInitials={initialsForApp(name || seed)}
      className="shadow-brutal-sm"
    />
  );
}

function ConnectedAppUrlLink({ url, label, className = "" }: { url?: string | null; label?: string | null; className?: string }) {
  const href = url?.trim();
  if (!href) return null;
  const visibleLabel = label?.trim() || href;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      onClick={(event) => event.stopPropagation()}
      title={href}
      className={`inline-flex max-w-full min-w-0 items-center gap-1.5 text-xs font-mono font-bold text-black/55 underline decoration-2 underline-offset-2 hover:text-black ${className}`.trim()}
    >
      <ExternalLink size={12} className="shrink-0" />
      <span className="min-w-0 truncate">{visibleLabel}</span>
    </a>
  );
}

function OAuthScopeNegativeCapabilityBlock({ className = "" }: { className?: string }) {
  const { formatMessage } = useIntl();
  return (
    <div className={`border-2 border-black bg-soft-signal/25 p-3 text-xs font-bold leading-relaxed text-black shadow-brutal-sm ${className}`.trim()}>
      {formatMessage({ id: AGENT_INBOUND_NEGATIVE_CAPABILITY_ID })}
    </div>
  );
}

// Exported for settingsSubBatchG.i18n.behavior.test.tsx — presentational (takes a
// scope array), so the zh tooth renders the real component with no API harness.
export function OAuthScopeList({
  scopes,
  compact = true,
  defaultToDeclared = true,
}: {
  scopes: readonly string[] | null | undefined;
  compact?: boolean;
  defaultToDeclared?: boolean;
}) {
  const { formatMessage } = useIntl();
  const visibleScopes = defaultToDeclared ? normalizeDeclaredOAuthScopes(scopes) : normalizeDeclaredOAuthScopes(scopes).filter((scope) => scopes?.includes(scope));
  const grouped: Record<OAuthScopeTier, RaftOAuthScopeId[]> = {
    identity: visibleScopes.filter((scope) => OAUTH_SCOPE_PRESENTATION[scope].tier === "identity"),
    agent_messaging: visibleScopes.filter((scope) => OAUTH_SCOPE_PRESENTATION[scope].tier === "agent_messaging"),
  };

  return (
    <div className="space-y-3" data-testid="oauth-scope-list">
      {visibleScopes.length === 0 && (
        <div className="border-2 border-black/15 bg-white p-2 text-xs font-bold text-black/55">
          {formatMessage({ id: "settings.connectedApps.noGrantScopes" })}
        </div>
      )}
      {compact ? (
        <div className="flex flex-wrap gap-1.5">
          {visibleScopes.map((scope) => {
            const detail = OAUTH_SCOPE_PRESENTATION[scope];
            return (
              <span
                key={scope}
                title={formatMessage({ id: detail.copyId })}
                className={`inline-flex items-center border border-black/20 bg-white px-2 py-1 text-[11px] font-bold text-black/70 ${detail.requiresResource ? "bg-soft-signal/20" : ""}`}
              >
                {scope}
              </span>
            );
          })}
        </div>
      ) : (
        <>
          {(["identity", "agent_messaging"] as OAuthScopeTier[]).map((tier) => {
            const tierScopes = grouped[tier];
            if (tierScopes.length === 0) return null;
            return (
              <div key={tier} className="space-y-2">
                <div className="text-[10px] font-black uppercase tracking-widest text-black/50">{formatMessage({ id: scopeGroupLabelId(tier) })}</div>
                <div className="space-y-2">
                  {tierScopes.map((scope) => {
                    const detail = OAUTH_SCOPE_PRESENTATION[scope];
                    return (
                      <div key={scope} className="border-2 border-black/15 bg-white p-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <code className="break-all text-[11px] font-bold text-black/70">{scope}</code>
                          {detail.requiresResource && <Badge appearance="outline">{formatMessage({ id: "settings.connectedApps.scopeRequiresResource" })}</Badge>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </>
      )}
      {!compact && hasAgentInboundOAuthScope(visibleScopes) && <OAuthScopeNegativeCapabilityBlock />}
    </div>
  );
}

function OAuthScopeSummaryPanel({
  title,
  description,
  scopes,
  compact = true,
  defaultToDeclared = true,
  defaultOpen = false,
}: {
  title: string;
  description?: string;
  scopes: readonly string[] | null | undefined;
  compact?: boolean;
  defaultToDeclared?: boolean;
  defaultOpen?: boolean;
}) {
  const { formatMessage } = useIntl();
  return (
    <div className="space-y-2">
      <SectionEyebrow as="div">{title}</SectionEyebrow>
      {description && <div className="mt-2 text-xs leading-relaxed text-black/60">{description}</div>}
      <details open={defaultOpen} className="border-2 border-black/15 bg-brutal-cream p-2">
        <summary className="text-xs font-black text-black">{formatMessage({ id: "settings.connectedApps.detail.declaredAccess" })}</summary>
        <div className="mt-2">
          <OAuthScopeList scopes={scopes} compact={compact} defaultToDeclared={defaultToDeclared} />
        </div>
      </details>
    </div>
  );
}

function ConnectedAppDetailSection({
  title,
  description,
  children,
  tone = "white",
}: {
  title: string;
  description?: string;
  children: ReactNode;
  tone?: "white" | "cream";
}) {
  return (
    <section className={`border-2 border-black p-3 shadow-brutal-sm ${tone === "cream" ? "bg-brutal-cream" : "bg-white"}`}>
      <SectionEyebrow as="div">{title}</SectionEyebrow>
      {description && <div className="mt-1 text-xs leading-relaxed text-black/60">{description}</div>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

function ConnectedAppDetailRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1 py-2 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
      <span className="shrink-0 text-black/55">{label}</span>
      <div className="min-w-0 text-left font-bold text-black sm:text-right">{children}</div>
    </div>
  );
}

// Exported for settingsSubBatchD.i18n.behavior.test.tsx — see above.
export function DeclaredScopesPicker({
  value,
  onChange,
}: {
  value: readonly RaftOAuthScopeId[];
  onChange: (next: RaftOAuthScopeId[]) => void;
}) {
  const { formatMessage } = useIntl();
  const selected = new Set<RaftOAuthScopeId>([...IDENTITY_OAUTH_SCOPES, ...value]);
  const updateScope = (scope: RaftOAuthScopeId, checked: boolean) => {
    if (IDENTITY_OAUTH_SCOPES.includes(scope)) return;
    const next = new Set(selected);
    if (checked) next.add(scope);
    else next.delete(scope);
    onChange([
      ...IDENTITY_OAUTH_SCOPES,
      ...OPTIONAL_IDENTITY_OAUTH_SCOPES.filter((item) => next.has(item)),
      ...AGENT_INBOUND_OAUTH_SCOPES.filter((item) => next.has(item)),
    ]);
  };

  return (
    <div className="border-2 border-black bg-white p-3 shadow-brutal-sm" data-testid="connected-app-declared-scopes">
      <SectionEyebrow as="div">{formatMessage({ id: "settings.connectedApps.declaredScopesTitle" })}</SectionEyebrow>
      <div className="mt-1 text-xs leading-relaxed text-black/60">
        {formatMessage({ id: "settings.connectedApps.declaredScopesDescription" })}
      </div>
      <div className="mt-3 space-y-2">
        <details className="border-2 border-black/15 bg-brutal-cream p-2">
          <summary className="text-xs font-black text-black">
            {formatMessage({ id: "settings.connectedApps.identitySection" })}
          </summary>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {IDENTITY_OAUTH_SCOPES.map((scope) => {
              const detail = OAUTH_SCOPE_PRESENTATION[scope];
              return (
                <span key={scope} title={formatMessage({ id: detail.copyId })} className="inline-flex items-center border border-black/20 bg-white px-2 py-1 text-[11px] font-bold text-black/70">
                  {scope}
                </span>
              );
            })}
            {OPTIONAL_IDENTITY_OAUTH_SCOPES.map((scope) => {
              const detail = OAUTH_SCOPE_PRESENTATION[scope];
              return (
                <label key={scope} title={formatMessage({ id: detail.copyId })} className="inline-flex items-center gap-2 border border-black/20 bg-white px-2 py-1 text-[11px] font-bold text-black/70">
                  <Checkbox
                    size="sm"
                    checked={selected.has(scope)}
                    onChange={(event) => updateScope(scope, event.currentTarget.checked)}
                  />
                  <span>{scope}</span>
                </label>
              );
            })}
          </div>
        </details>
        <details open className="border-2 border-black/15 bg-brutal-cream p-2">
          <summary className="text-xs font-black text-black">
            {formatMessage({ id: "settings.connectedApps.agentMessagingSection" })}
          </summary>
          <div className="mt-2 flex flex-wrap gap-2">
            {AGENT_INBOUND_OAUTH_SCOPES.map((scope) => {
              const detail = OAUTH_SCOPE_PRESENTATION[scope];
              return (
                <label key={scope} title={formatMessage({ id: detail.copyId })} className="inline-flex items-center gap-2 border border-black/20 bg-white px-2 py-1.5 text-xs font-bold text-black/70">
                  <Checkbox
                    size="sm"
                    checked={selected.has(scope)}
                    onChange={(event) => updateScope(scope, event.currentTarget.checked)}
                  />
                  <span>{scope}</span>
                </label>
              );
            })}
          </div>
          {hasAgentInboundOAuthScope(value) && (
            <div className="mt-2 text-xs font-bold text-black/55">
              {formatMessage({ id: "settings.connectedApps.scopeRequiresResourceDetail" })}
            </div>
          )}
        </details>
      </div>
    </div>
  );
}

function renderMarketplaceText(field: "app_name" | "developer_name" | "description", value: string | null | undefined) {
  return renderThirdPartyInertText({ field, value });
}

function mapClientToMarketplaceApp(
  client: MarketplaceOAuthClientRecord,
  formatMessage: IntlShape["formatMessage"],
): ConnectedAppListing {
  const notConfigured = formatMessage({ id: "settings.connectedApps.notConfigured" });
  const thirdPartyDeveloper = formatMessage({ id: "settings.connectedApps.thirdPartyDeveloper" });
  return {
    id: client.id,
    clientId: client.clientId,
    name: renderMarketplaceText("app_name", client.name),
    category: client.category,
    developer: renderMarketplaceText("developer_name", client.publisherServerName ?? client.publisherName ?? thirdPartyDeveloper),
    description: renderMarketplaceText("description", client.description),
    homepageUrl: client.homepageUrl,
    homepageDomain: getDomainFromUrl(client.homepageUrl) ?? notConfigured,
    callbackDomain: getDomainFromUrl(client.returnUrl) ?? notConfigured,
    logoUrl: client.logoUrl,
    defaultLogoSeed: client.clientId,
    installed: !!client.installedAt,
    marketplaceInstallBadge: client.marketplaceInstallBadge ?? { kind: "none" },
    allowedScopes: client.allowedScopes,
    appNotificationGroups: client.appNotificationGroups ?? [],
    appNotificationEvents: client.appNotificationEvents ?? [],
    appNotificationReviewPending: client.appNotificationReviewPending ?? false,
  };
}

function mapClientToBuiltInApp(client: BuiltInOAuthClientRecord): BuiltInConnectedApp {
  return {
    id: client.id,
    clientId: client.clientId,
    name: client.name,
    description: client.description,
    homepageUrl: client.homepageUrl,
    homepageDomain: getDomainFromUrl(client.homepageUrl),
    agentManifestUrl: client.agentManifestUrl,
    logoUrl: null,
    defaultLogoSeed: client.clientId,
    allowedScopes: client.allowedScopes,
  };
}

function mapClientToRegisteredApp(client: OAuthClientRecord): ServerRegisteredApp {
  return {
    ...client,
    status: client.publishStatus,
    logoUrl: client.logoUrl,
    defaultLogoSeed: client.clientId,
  };
}

export function IntegrationsSection() {
  const { formatDate, formatMessage } = useIntl();
  const current = useServerStore((s) => s.current);
  const { capabilities } = useServerPermissions();
  const canManage = capabilities.manageIntegrations;
  const connectedAppsLabel = formatMessage({ id: "settings.connectedApps.label" });

  const [activeTab, setActiveTab] = useState<ConnectedAppsTab>("marketplace");
  const [connectedAppsSearch, setConnectedAppsSearch] = useState("");
  const [connectedAppsCategory, setConnectedAppsCategory] = useState<ConnectedAppCategory | "all">("all");
  const [connectedAppsViewMode, setConnectedAppsViewMode] = useState<ConnectedAppsViewMode>(getInitialConnectedAppsViewMode);
  const [selectedListing, setSelectedListing] = useState<ConnectedAppListing | null>(null);
  const [selectedBuiltInApp, setSelectedBuiltInApp] = useState<BuiltInConnectedApp | null>(null);
  const [selectedInstalledApp, setSelectedInstalledApp] = useState<InstalledConnectedApp | null>(null);
  const [marketplaceClients, setMarketplaceClients] = useState<MarketplaceOAuthClientRecord[]>([]);
  const [builtInClients, setBuiltInClients] = useState<BuiltInOAuthClientRecord[]>([]);
  const [clients, setClients] = useState<OAuthClientRecord[]>([]);
  const [integrationOverview, setIntegrationOverview] = useState<IntegrationOverviewItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [logoUploading, setLogoUploading] = useState(false);
  const [error, setError] = useState("");
  const [createdSecret, setCreatedSecret] = useState<string | null>(null);
  const [createdSecretClientId, setCreatedSecretClientId] = useState<string | null>(null);
  const [secretCopied, setSecretCopied] = useState(false);
  const [showRegisterDrawer, setShowRegisterDrawer] = useState(false);
  const [appEditorSection, setAppEditorSection] = useState<ConnectedAppEditorSectionId>("profile");
  const [editingClient, setEditingClient] = useState<OAuthClientRecord | null>(null);
  const [savingClientId, setSavingClientId] = useState<string | null>(null);
  const [regeneratingClientId, setRegeneratingClientId] = useState<string | null>(null);
  const [regenerateSecretTarget, setRegenerateSecretTarget] = useState<OAuthClientRecord | null>(null);
  const [deleteClientTarget, setDeleteClientTarget] = useState<ServerRegisteredApp | null>(null);
  const [offlineRequestTarget, setOfflineRequestTarget] = useState<ServerRegisteredApp | null>(null);
  const [marketplaceUninstallTarget, setMarketplaceUninstallTarget] = useState<InstalledConnectedApp | ConnectedAppListing | null>(null);
  const [clientName, setClientName] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientDescription, setClientDescription] = useState("");
  const [clientHomepageUrl, setClientHomepageUrl] = useState("");
  const [clientReturnUrl, setClientReturnUrl] = useState("");
  const [clientAgentManifestUrl, setClientAgentManifestUrl] = useState("");
  const [clientAllowedScopes, setClientAllowedScopes] = useState<RaftOAuthScopeId[]>([...DEFAULT_DECLARED_OAUTH_SCOPES]);
  const [appNotificationSelection, setAppNotificationSelection] = useState<AppNotificationSelection>({ groups: [], events: [] });
  const [appNotificationState, setAppNotificationState] = useState<AppNotificationsDeveloperState | null>(null);
  const [appNotificationLoading, setAppNotificationLoading] = useState(false);
  const [appNotificationConfigurationOpen, setAppNotificationConfigurationOpen] = useState(false);
  const [clientCategory, setClientCategory] = useState<ConnectedAppCategory>("Other");
  const [shareLink, setShareLink] = useState<OAuthClientShareLinkRecord | null>(null);
  const [shareUrl, setShareUrl] = useState("");
  const [shareLoading, setShareLoading] = useState(false);
  const [shareCopied, setShareCopied] = useState(false);
  const logoInputRef = useRef<HTMLInputElement | null>(null);
  const appEditorRailRef = useRef<HTMLElement | null>(null);
  const appEditorContentRef = useRef<HTMLDivElement | null>(null);
  const secretCopyResetRef = useRef<ReturnType<typeof window.setTimeout> | null>(null);
  const shareCopyResetRef = useRef<ReturnType<typeof window.setTimeout> | null>(null);

  const load = async () => {
    if (!current) return;
    setLoading(true);
    setError("");
    try {
      const [clientsRes, builtInRes, marketplaceRes, overviewRes] = await Promise.all([
        api.get("/integrations/clients"),
        api.get("/integrations/built-in"),
        api.get("/integrations/marketplace"),
        api.get("/integrations/overview"),
      ]);
      setClients(clientsRes.data);
      setBuiltInClients(builtInRes.data);
      const nextMarketplaceClients = marketplaceRes.data as MarketplaceOAuthClientRecord[];
      setMarketplaceClients(nextMarketplaceClients);
      const requestedMarketplaceId = new URLSearchParams(window.location.search).get("marketplace_app")?.trim();
      if (requestedMarketplaceId) {
        const requestedListing = nextMarketplaceClients
          .filter((app) => !app.privateShared)
          .map((client) => mapClientToMarketplaceApp(client, formatMessage))
          .find((app) => app.id === requestedMarketplaceId || app.clientId === requestedMarketplaceId);
        if (requestedListing) setSelectedListing(requestedListing);
      }
      setIntegrationOverview(overviewRes.data);
    } catch (err: any) {
      setError(err.response?.data?.error || formatMessage({ id: "settings.connectedApps.failedLoad" }));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id]);

  useEffect(() => {
    return () => {
      if (secretCopyResetRef.current) {
        window.clearTimeout(secretCopyResetRef.current);
      }
      if (shareCopyResetRef.current) {
        window.clearTimeout(shareCopyResetRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const rail = appEditorRailRef.current;
    const active = rail?.querySelector<HTMLElement>(`[data-app-editor-section="${appEditorSection}"]`);
    if (!rail || !active || rail.scrollWidth <= rail.clientWidth) return;
    const left = active.offsetLeft - (rail.clientWidth - active.offsetWidth) / 2;
    rail.scrollTo?.({ left: Math.max(0, left), behavior: "smooth" });
  }, [appEditorSection]);

  const resetForm = () => {
    setClientName("");
    setClientId("");
    setClientDescription("");
    setClientHomepageUrl("");
    setClientReturnUrl("");
    setClientAgentManifestUrl("");
    setClientAllowedScopes([...DEFAULT_DECLARED_OAUTH_SCOPES]);
    setAppNotificationSelection({ groups: [], events: [] });
    setAppNotificationState(null);
    setAppNotificationLoading(false);
    setAppNotificationConfigurationOpen(false);
    setClientCategory("Other");
  };

  const resetShareState = () => {
    setShareLink(null);
    setShareUrl("");
    setShareCopied(false);
  };

  const openRegisterDrawer = () => {
    setEditingClient(null);
    setAppEditorSection("profile");
    resetForm();
    setCreatedSecret(null);
    setCreatedSecretClientId(null);
    setSecretCopied(false);
    setError("");
    resetShareState();
    setShowRegisterDrawer(true);
  };

  const loadShareLink = async (clientId: string) => {
    setShareLoading(true);
    resetShareState();
    try {
      const { data } = await api.get(`/integrations/clients/${clientId}/share-link`);
      setShareLink(data);
    } catch (err: any) {
      if (err.response?.status !== 404) {
        setError(err.response?.data?.error || formatMessage({ id: "settings.connectedApps.failedLoadShare" }));
      }
    } finally {
      setShareLoading(false);
    }
  };

  const loadAppNotificationState = async (clientId: string) => {
    setAppNotificationLoading(true);
    try {
      const { data } = await api.get(`/integrations/clients/${clientId}/app-notifications`);
      if (
        !data
        || typeof data !== "object"
        || Array.isArray(data)
        || !Array.isArray(data.current_groups)
        || !Array.isArray(data.current_events)
      ) {
        throw new Error("Invalid App Notifications settings response");
      }
      setAppNotificationState(data);
      setAppNotificationConfigurationOpen(!!data.webhook?.enabled);
      const requested = data.pending_revision ?? {
        groups: data.current_groups,
        events: data.current_events,
      };
      setAppNotificationSelection({ groups: requested.groups, events: requested.events });
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: { error?: string } } };
      setError(axiosErr.response?.data?.error || formatMessage({ id: "settings.connectedApps.failedLoadAppNotifications" }));
    } finally {
      setAppNotificationLoading(false);
    }
  };

  const beginEditClient = (client: OAuthClientRecord) => {
    setEditingClient(client);
    setAppEditorSection("profile");
    setClientName(client.name);
    setClientId(client.clientId);
    setClientDescription(client.description ?? "");
    setClientHomepageUrl(client.homepageUrl ?? "");
    setClientReturnUrl(client.returnUrl ?? "");
    setClientAgentManifestUrl(client.agentManifestUrl ?? "");
    setClientAllowedScopes(normalizeDeclaredOAuthScopes(client.allowedScopes));
    setAppNotificationSelection({ groups: [], events: [] });
    setAppNotificationState(null);
    setAppNotificationConfigurationOpen(false);
    setClientCategory(client.category);
    if (createdSecretClientId !== client.id) {
      setCreatedSecret(null);
      setCreatedSecretClientId(null);
    }
    setSecretCopied(false);
    setError("");
    void loadShareLink(client.id);
    void loadAppNotificationState(client.id);
    setShowRegisterDrawer(true);
  };

  const closeRegisterDrawer = () => {
    setShowRegisterDrawer(false);
    setEditingClient(null);
    setAppEditorSection("profile");
    setError("");
    resetShareState();
    resetForm();
  };

  const applyUpdatedClient = (client: OAuthClientRecord) => {
    setClients((items) => items.map((item) => item.id === client.id ? client : item));
    setEditingClient((currentClient) => currentClient?.id === client.id ? client : currentClient);
  };

  const saveAppNotificationPermissions = async (clientRowId: string) => {
    await api.put(`/integrations/clients/${clientRowId}/app-notifications/permissions`, {
      groups: appNotificationSelection.groups,
      events: appNotificationSelection.events,
    });
  };

  const emptyAppNotificationState = (): AppNotificationsDeveloperState => ({
    request_revision: 0,
    current_revision_id: null,
    current_groups: [],
    current_events: [],
    pending_revision: null,
    webhook: null,
  });

  const appNotificationRequestChanged = () => {
    if (!appNotificationState) return appNotificationSelection.groups.length > 0 || appNotificationSelection.events.length > 0;
    const requested = appNotificationState.pending_revision ?? {
      groups: appNotificationState.current_groups,
      events: appNotificationState.current_events,
    };
    return requested.groups.join("\0") !== appNotificationSelection.groups.join("\0")
      || requested.events.join("\0") !== appNotificationSelection.events.join("\0");
  };

  const handleSaveClient = async (event: FormEvent) => {
    event.preventDefault();
    if (!current) return;
    setSubmitting(true);
    setSavingClientId(editingClient?.id ?? null);
    setError("");
    if (!editingClient) setCreatedSecret(null);
    try {
      if (editingClient) {
        const { data } = await api.patch(`/integrations/clients/${editingClient.id}`, {
          name: clientName,
          description: clientDescription || null,
          homepageUrl: clientHomepageUrl || null,
          returnUrl: clientReturnUrl || null,
          agentManifestUrl: clientAgentManifestUrl || null,
          allowedScopes: clientAllowedScopes,
          category: clientCategory,
        });
        applyUpdatedClient(data);
        if (appNotificationState && appNotificationRequestChanged()) {
          await saveAppNotificationPermissions(editingClient.id);
        }
        closeRegisterDrawer();
      } else {
        const { data } = await api.post("/integrations/clients", {
          name: clientName,
          clientId: clientId || undefined,
          description: clientDescription || undefined,
          homepageUrl: clientHomepageUrl || undefined,
          returnUrl: clientReturnUrl || undefined,
          agentManifestUrl: clientAgentManifestUrl || undefined,
          allowedScopes: clientAllowedScopes,
          category: clientCategory,
        });
        setCreatedSecret(data.clientSecret);
        setCreatedSecretClientId(data.client.id);
        setSecretCopied(false);
        setEditingClient(data.client);
        setClientId(data.client.clientId);
        setClients((items) => [...items, data.client]);
        setAppNotificationState(emptyAppNotificationState());
        if (appNotificationRequestChanged()) {
          await saveAppNotificationPermissions(data.client.id);
        }
        resetForm();
        setShowRegisterDrawer(false);
        setActiveTab("myapps");
        await load();
      }
    } catch (err: any) {
      setError(err.response?.data?.error || (editingClient ? formatMessage({ id: "settings.connectedApps.failedUpdateApp" }) : formatMessage({ id: "settings.connectedApps.failedRegisterApp" })));
    } finally {
      setSubmitting(false);
      setSavingClientId(null);
    }
  };

  const handleCopyCreatedSecret = async () => {
    if (!createdSecret) return;
    setError("");
    try {
      await navigator.clipboard.writeText(createdSecret);
      setSecretCopied(true);
      if (secretCopyResetRef.current) {
        window.clearTimeout(secretCopyResetRef.current);
      }
      secretCopyResetRef.current = window.setTimeout(() => {
        setSecretCopied(false);
        secretCopyResetRef.current = null;
      }, 1500);
    } catch (err: any) {
      setError(err?.message || formatMessage({ id: "settings.connectedApps.failedCopySecret" }));
    }
  };

  const handleRegenerateClientSecret = async (client: OAuthClientRecord) => {
    setRegeneratingClientId(client.id);
    setError("");
    try {
      const { data } = await api.post(`/integrations/clients/${client.id}/regenerate-secret`);
      applyUpdatedClient(data.client);
      setCreatedSecret(data.clientSecret);
      setCreatedSecretClientId(data.client.id);
      setSecretCopied(false);
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: { error?: string } } };
      setError(axiosErr.response?.data?.error || formatMessage({ id: "settings.connectedApps.regenerateSecretFailed" }));
      throw err;
    } finally {
      setRegeneratingClientId(null);
    }
  };

  const handleCreateShareLink = async () => {
    if (!editingClient) return;
    setShareLoading(true);
    setError("");
    try {
      const { data } = await api.post(`/integrations/clients/${editingClient.id}/share-link`);
      applyUpdatedClient(data.client);
      setShareLink(data.link);
      setShareUrl(`${window.location.origin}/integration-invites/${encodeURIComponent(data.token)}`);
      setShareCopied(false);
    } catch (err: any) {
      setError(err.response?.data?.error || formatMessage({ id: "settings.connectedApps.failedCreateShare" }));
    } finally {
      setShareLoading(false);
    }
  };

  const handleRevokeShareLink = async () => {
    if (!editingClient) return;
    setShareLoading(true);
    setError("");
    try {
      await api.delete(`/integrations/clients/${editingClient.id}/share-link`);
      resetShareState();
    } catch (err: any) {
      setError(err.response?.data?.error || formatMessage({ id: "settings.connectedApps.failedRevokeShare" }));
    } finally {
      setShareLoading(false);
    }
  };

  const handleCopyShareUrl = async () => {
    if (!shareUrl) return;
    setError("");
    try {
      await navigator.clipboard.writeText(shareUrl);
      setShareCopied(true);
      if (shareCopyResetRef.current) {
        window.clearTimeout(shareCopyResetRef.current);
      }
      shareCopyResetRef.current = window.setTimeout(() => {
        setShareCopied(false);
        shareCopyResetRef.current = null;
      }, 1500);
    } catch (err: any) {
      setError(err?.message || formatMessage({ id: "settings.connectedApps.failedCopyShare" }));
    }
  };

  const handleLogoFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!editingClient || !file) return;
    setLogoUploading(true);
    setError("");
    try {
      const formData = new FormData();
      formData.append("logo", file);
      const { data } = await api.post(`/integrations/clients/${editingClient.id}/logo`, formData);
      applyUpdatedClient(data);
    } catch (err: any) {
      setError(err.response?.data?.error || formatMessage({ id: "settings.connectedApps.failedUploadLogo" }));
    } finally {
      setLogoUploading(false);
      event.target.value = "";
    }
  };

  const handleClearLogo = async () => {
    if (!editingClient) return;
    setLogoUploading(true);
    setError("");
    try {
      const { data } = await api.delete(`/integrations/clients/${editingClient.id}/logo`);
      applyUpdatedClient(data);
    } catch (err: any) {
      setError(err.response?.data?.error || formatMessage({ id: "settings.connectedApps.failedResetLogo" }));
    } finally {
      setLogoUploading(false);
    }
  };

  const handleDeleteClient = async (client: ServerRegisteredApp) => {
    await api.delete(`/integrations/clients/${client.id}`);
    setClients((items) => items.filter((item) => item.id !== client.id));
    if (editingClient?.id === client.id) {
      closeRegisterDrawer();
    }
  };

  const handleRequestPublish = async (client: ServerRegisteredApp) => {
    setSavingClientId(client.id);
    setError("");
    try {
      await api.patch(`/integrations/clients/${client.id}`, {
        name: clientName,
        description: clientDescription || null,
        homepageUrl: clientHomepageUrl || null,
        returnUrl: clientReturnUrl || null,
        agentManifestUrl: clientAgentManifestUrl || null,
        allowedScopes: clientAllowedScopes,
        category: clientCategory,
      });
      const { data } = await api.post(`/integrations/clients/${client.id}/request-publish`);
      applyUpdatedClient(data);
    } catch (err: any) {
      setError(err.response?.data?.error || formatMessage({ id: "settings.connectedApps.failedRequestPublish" }));
    } finally {
      setSavingClientId(null);
    }
  };

  const handleRequestOffline = async (client: ServerRegisteredApp) => {
    setSavingClientId(client.id);
    setError("");
    try {
      const { data } = await api.post(`/integrations/clients/${client.id}/request-unpublish`);
      applyUpdatedClient(data);
      setOfflineRequestTarget(null);
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: { error?: string } } };
      setError(axiosErr.response?.data?.error || formatMessage({ id: "settings.connectedApps.marketplaceReviewFailed" }));
    } finally {
      setSavingClientId(null);
    }
  };

  const handleInstallMarketplaceApp = async (listing: ConnectedAppListing) => {
    setSavingClientId(listing.id);
    setError("");
    try {
      await api.post(`/integrations/marketplace/${listing.id}/install`);
      setSelectedListing(null);
      await load();
    } catch (err: any) {
      setError(err.response?.data?.error || formatMessage({ id: "settings.connectedApps.failedInstall" }));
    } finally {
      setSavingClientId(null);
    }
  };

  const handleUninstallMarketplaceApp = async (app: InstalledConnectedApp | ConnectedAppListing) => {
    setSavingClientId(app.id);
    setError("");
    try {
      await api.delete(`/integrations/marketplace/${app.id}/install`);
      setSelectedListing(null);
      setMarketplaceUninstallTarget(null);
      await load();
    } catch (err: any) {
      setError(err.response?.data?.error || formatMessage({ id: "settings.connectedApps.failedUninstall" }));
    } finally {
      setSavingClientId(null);
    }
  };

  const openBuiltInApp = (app: BuiltInConnectedApp) => {
    if (!app.homepageUrl) return;
    window.open(app.homepageUrl, "_blank", "noopener,noreferrer");
  };

  const builtInApps = builtInClients.map(mapClientToBuiltInApp);
  const registeredApps = clients.map(mapClientToRegisteredApp);
  const grantedScopesByClientId = integrationOverview
    .filter((item) => item.type === "active" && !item.revokedAt)
    .reduce((map, item) => {
      const current = map.get(item.clientId) ?? new Set<string>();
      item.scopes.forEach((scope) => current.add(scope));
      map.set(item.clientId, current);
      return map;
    }, new Map<string, Set<string>>());
  const grantedScopesForClient = (id: string) => Array.from(grantedScopesByClientId.get(id) ?? []);
  const editableSourceOwnedClientIds = new Set(registeredApps
    .filter((app) => app.appType === "server_local" || (app.appType === "third_party_global" && canEditSourceOwnedConnectedApp(app.status)))
    .map((app) => app.id));
  const installedApps: InstalledConnectedApp[] = [
    ...marketplaceClients.filter((app) => app.installedAt && !editableSourceOwnedClientIds.has(app.id)).map((app) => ({
      id: app.id,
      clientId: app.clientId,
      name: renderMarketplaceText("app_name", app.name),
      developer: renderMarketplaceText("developer_name", app.publisherServerName ?? app.publisherName ?? formatMessage({ id: "settings.connectedApps.thirdPartyDeveloper" })),
      description: renderMarketplaceText("description", app.description),
      homepageUrl: app.homepageUrl,
      homepageDomain: getDomainFromUrl(app.homepageUrl),
      callbackDomain: getDomainFromUrl(app.returnUrl),
      logoUrl: app.logoUrl,
      defaultLogoSeed: app.clientId,
      origin: "marketplace" as const,
      privateShared: app.privateShared,
      editable: false,
      category: app.category,
      publishStatus: app.publishStatus ?? null,
      allowedScopes: app.allowedScopes,
      grantedScopes: grantedScopesForClient(app.id),
    })),
    ...registeredApps.filter((app) => editableSourceOwnedClientIds.has(app.id)).map((app) => ({
      id: app.id,
      clientId: app.clientId,
      name: app.name,
      developer: formatMessage({ id: "settings.connectedApps.thisServer" }),
      description: app.description,
      homepageUrl: app.homepageUrl,
      homepageDomain: getDomainFromUrl(app.homepageUrl),
      callbackDomain: getDomainFromUrl(app.returnUrl),
      logoUrl: app.logoUrl,
      defaultLogoSeed: app.defaultLogoSeed,
      origin: "private" as const,
      privateShared: false,
      editable: true,
      category: app.category,
      publishStatus: app.status,
      allowedScopes: app.allowedScopes,
      grantedScopes: grantedScopesForClient(app.id),
      sourceClientId: app.id,
    })),
  ];
  const publicMarketplaceClients = marketplaceClients.filter((app) => !app.privateShared);
  const normalizedSearch = connectedAppsSearch.trim().toLowerCase();
  const marketplaceApps = publicMarketplaceClients
    .map((client) => mapClientToMarketplaceApp(client, formatMessage))
    .filter((app) => matchesConnectedAppFilter(app, normalizedSearch, connectedAppsCategory));

  const filteredInstalledApps = installedApps
    .filter((app) => matchesConnectedAppFilter(app, normalizedSearch, connectedAppsCategory));
  const filteredRegisteredApps = registeredApps
    .filter((app) => matchesConnectedAppFilter(app, normalizedSearch, connectedAppsCategory));
  const marketplaceCount = builtInApps.length + publicMarketplaceClients.length;
  const connectedAppsTabOptions = [
    { value: "marketplace" as const, label: formatMessage({ id: "settings.connectedApps.tabMarketplace" }), count: marketplaceCount, testId: "connected-apps-tab-marketplace" },
    { value: "installed" as const, label: formatMessage({ id: "settings.connectedApps.installed" }), count: installedApps.length, testId: "connected-apps-tab-installed" },
    { value: "myapps" as const, label: formatMessage({ id: "settings.connectedApps.tabMyApps" }), count: registeredApps.length, testId: "connected-apps-tab-my-apps" },
  ];
  const connectedAppsErrorSurface = getConnectedAppsErrorSurface(
    error,
    selectedListing,
    selectedBuiltInApp,
    showRegisterDrawer,
    deleteClientTarget,
    offlineRequestTarget,
    marketplaceUninstallTarget,
  );
  const updateConnectedAppsViewMode = (viewMode: ConnectedAppsViewMode) => {
    setConnectedAppsViewMode(viewMode);
    try {
      window.localStorage.setItem(CONNECTED_APPS_VIEW_MODE_STORAGE_KEY, viewMode);
    } catch {
      // The preference is optional; the view switch must keep working when storage is unavailable.
    }
  };

  const renderClientSecretReveal = () => {
    if (!createdSecret) return null;
    return (
      <div className="border-2 border-black bg-brutal-lime/20 p-3 space-y-2">
        <SectionEyebrow as="div">{formatMessage({ id: "settings.connectedApps.clientSecret" })}</SectionEyebrow>
        <div className="text-sm text-black">{formatMessage({ id: "settings.connectedApps.secretOnce" })}</div>
        <div className="flex items-center gap-2">
          <div className="flex-1 border-2 border-black bg-white p-2 font-mono text-xs break-all">{createdSecret}</div>
          <button
            type="button"
            onClick={() => void handleCopyCreatedSecret()}
            className="btn-brutal-sm shrink-0 bg-white p-2"
            data-testid="connected-app-secret-copy-button"
            aria-live="polite"
            aria-label={secretCopied ? formatMessage({ id: "settings.connectedApps.copiedSecret" }) : formatMessage({ id: "settings.connectedApps.copySecret" })}
            title={secretCopied ? formatMessage({ id: "settings.connectedApps.copiedSecret" }) : formatMessage({ id: "settings.connectedApps.copySecret" })}
          >
            {secretCopied ? <Check size={14} /> : <Copy size={14} />}
          </button>
        </div>
      </div>
    );
  };

  const profileStatus = formatMessage({ id: clientName.trim() && clientDescription.trim() && clientHomepageUrl.trim()
    ? "settings.connectedApps.editor.status.complete"
    : "settings.connectedApps.editor.status.needsDetails" });
  const loginStatus = formatMessage({ id: clientReturnUrl.trim()
    ? (editingClient
      ? "settings.connectedApps.editor.status.oauthReady"
      : "settings.connectedApps.editor.status.readyToSave")
    : "settings.connectedApps.editor.status.callbackMissing" });
  const notificationsStatus = appNotificationLoading
    ? formatMessage({ id: "common.loadingLabel" })
    : formatMessage({ id: !editingClient
      ? "settings.connectedApps.editor.status.saveAppFirst"
      : appNotificationState?.webhook?.enabled
        ? "settings.connectedApps.editor.status.enabled"
        : appNotificationConfigurationOpen
          ? "settings.connectedApps.editor.status.setup"
          : "settings.connectedApps.editor.status.off" });
  const distributionStatus = formatMessage({ id: connectedAppDistributionStatus(editingClient?.publishStatus ?? null) });
  const appEditorSections: Array<{
    id: ConnectedAppEditorSectionId;
    label: ReactNode;
    status: string;
    icon: ReactNode;
  }> = [
    { id: "profile", label: formatMessage({ id: "settings.connectedApps.section.profile" }), status: profileStatus, icon: <User size={14} /> },
    { id: "login", label: formatMessage({ id: "settings.connectedApps.section.loginWithRaft" }), status: loginStatus, icon: <Shield size={14} /> },
    { id: "notifications", label: <AppNotificationsEditorRailLabel />, status: notificationsStatus, icon: <Bell size={14} /> },
    { id: "distribution", label: formatMessage({ id: "settings.connectedApps.section.distribution" }), status: distributionStatus, icon: <Link2 size={14} /> },
    { id: "danger", label: formatMessage({ id: "settings.connectedApps.section.dangerZone" }), status: formatMessage({ id: editingClient ? "settings.connectedApps.editor.dangerStatusRestricted" : "settings.connectedApps.editor.dangerStatusAvailableAfterSave" }), icon: <AlertTriangle size={14} /> },
  ];
  const scrollToAppEditorSection = (sectionId: ConnectedAppEditorSectionId) => {
    setAppEditorSection(sectionId);
    const content = appEditorContentRef.current;
    const target = content?.querySelector<HTMLElement>(`#connected-app-editor-${sectionId}`);
    if (!content || !target) return;
    const top = target.getBoundingClientRect().top
      - content.getBoundingClientRect().top
      + content.scrollTop
      - 16;
    content.scrollTo?.({ top, behavior: "smooth" });
  };
  const syncAppEditorSectionFromScroll = () => {
    const content = appEditorContentRef.current;
    if (!content) return;

    let nextSection: ConnectedAppEditorSectionId = CONNECTED_APP_EDITOR_SECTION_IDS[0];
    const atBottom = content.scrollHeight - content.scrollTop - content.clientHeight <= 2;
    if (atBottom) {
      nextSection = CONNECTED_APP_EDITOR_SECTION_IDS[CONNECTED_APP_EDITOR_SECTION_IDS.length - 1];
    } else {
      const activationLine = content.getBoundingClientRect().top + 16;
      for (const sectionId of CONNECTED_APP_EDITOR_SECTION_IDS) {
        const target = content.querySelector<HTMLElement>(`#connected-app-editor-${sectionId}`);
        if (!target || target.getBoundingClientRect().top > activationLine) break;
        nextSection = sectionId;
      }
    }
    setAppEditorSection((current) => current === nextSection ? current : nextSection);
  };

  if (!current) return null;

  return (
    <div className="mb-6 space-y-4" data-testid="connected-apps-v3-section">
      <SectionHeader
        icon={<Link2 size={16} />}
        label={connectedAppsLabel}
        action={canManage ? (
          <button type="button" onClick={openRegisterDrawer} className="btn-brutal inline-flex items-center gap-1.5 bg-brutal-pink px-3 py-1.5 text-xs">
            <Plus size={14} />
            {formatMessage({ id: "settings.connectedApps.registerApp" })}
          </button>
        ) : undefined}
      />

      <div className="border-2 border-black bg-white p-4 shadow-brutal-sm">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div>
            <div className="text-sm font-bold text-black">{formatMessage({ id: "settings.connectedApps.title" })}</div>
            <div className="mt-1 max-w-2xl text-xs leading-relaxed text-black/60">
              {formatMessage({
                id: canManage
                  ? "settings.connectedApps.sectionDescriptionManage"
                  : "settings.connectedApps.sectionDescriptionView",
              })}
            </div>
            {!canManage && (
              <div className="mt-1 text-xs leading-relaxed text-black/60">
                {formatMessage({ id: "settings.connectedApps.adminOnlyNote" })}
              </div>
            )}
          </div>
          {loading && <div className="text-xs font-bold text-black/50">{formatMessage({ id: "settings.common.loading" })}</div>}
        </div>
        <ConnectedAppsTabSegmentedControl
          value={activeTab}
          options={connectedAppsTabOptions}
          className="mt-4"
          onValueChange={setActiveTab}
        />
      </div>

      <div className="grid items-stretch gap-2 sm:grid-cols-[minmax(0,1fr)_auto] md:grid-cols-[minmax(0,1fr)_220px_auto]" data-testid="connected-apps-filters">
        <div className="relative h-10 min-h-10">
          <input
            type="search"
            value={connectedAppsSearch}
            onChange={(event) => setConnectedAppsSearch(event.target.value)}
            placeholder={formatMessage({ id: "settings.connectedApps.searchApps" })}
            aria-label={formatMessage({ id: "settings.connectedApps.searchAppsAriaLabel" })}
            className="input-brutal box-border h-10 min-h-10 w-full text-sm"
            data-testid="connected-apps-search"
          />
        </div>
        <div className="h-10 min-h-10 min-w-0 sm:col-span-1 md:w-[220px]">
          <Select
            value={connectedAppsCategory}
            onValueChange={(value) => {
              if (value == null) return;
              setConnectedAppsCategory(value as ConnectedAppCategory | "all");
            }}
            items={CONNECTED_APP_CATEGORY_OPTIONS.map((option) => ({
              value: option.value,
              label: formatMessage({ id: CONNECTED_APP_CATEGORY_LABEL_ID[option.value] }),
            }))}
          >
            <SelectTrigger className="box-border h-10 min-h-10 w-full" data-testid="connected-apps-category-filter" aria-label={formatMessage({ id: "settings.connectedApps.filterByCategoryAriaLabel" })}>
              <SelectValue placeholder={formatMessage({ id: "settings.connectedApps.categoryLabel" })} />
              <SelectIcon />
            </SelectTrigger>
            <SelectContent>
              <SelectList>{renderSelectItems(CONNECTED_APP_CATEGORY_OPTIONS.map((option) => ({
                value: option.value,
                label: formatMessage({ id: CONNECTED_APP_CATEGORY_LABEL_ID[option.value] }),
              })))}</SelectList>
            </SelectContent>
          </Select>
        </div>
        <div className="flex h-10 min-h-10 justify-end sm:col-start-2 sm:row-start-1 md:col-start-3">
          <ConnectedAppsViewToggle value={connectedAppsViewMode} onValueChange={updateConnectedAppsViewMode} />
        </div>
      </div>

      <ConnectedAppsErrorBanner surface={connectedAppsErrorSurface} target={CONNECTED_APPS_ERROR_PAGE} error={error} />

      {canManage && !showRegisterDrawer && renderClientSecretReveal()}

      {activeTab === "marketplace" && (
        <div className="space-y-3" data-testid="connected-apps-marketplace-tab">
          {builtInApps.length > 0 && (
            <div className="border-2 border-black bg-brutal-cream p-3 shadow-brutal-sm" data-testid="connected-apps-built-in-band">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <SectionEyebrow as="div">{formatMessage({ id: "settings.connectedApps.builtIn" })}</SectionEyebrow>
                  <div className="mt-1 text-sm font-bold text-black">{formatMessage({ id: "settings.connectedApps.builtInAvailable" })}</div>
                </div>
              </div>
              <div
                className={`mt-3 ${connectedAppsCollectionClassName(connectedAppsViewMode)}`}
                data-testid="connected-apps-built-in-collection"
                data-view={connectedAppsViewMode}
              >
                {builtInApps.map((app) => (
                  <button
                    key={app.id}
                    type="button"
                    onClick={() => setSelectedBuiltInApp(app)}
                    className={`w-full border-2 border-black bg-white p-3 text-left shadow-brutal-sm transition-shadow hover:shadow-brutal ${
                      connectedAppsViewMode === "grid" ? "flex h-full flex-col" : "flex items-center gap-3"
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      <ConnectedAppLogo name={app.name} logoUrl={app.logoUrl} seed={app.defaultLogoSeed} />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <div className="font-bold text-black">{app.name}</div>
                          <Badge variant="success" uppercase>{formatMessage({ id: "settings.connectedApps.builtIn" })}</Badge>
                        </div>
                        <div className="mt-0.5 text-xs text-black/55">{formatMessage({ id: "settings.connectedApps.availableAll" })}</div>
                        {connectedAppsViewMode === "list" && (
                          <ConnectedAppSummary description={app.description} />
                        )}
                      </div>
                    </div>
                    <div className={`${connectedAppsViewMode === "grid" ? "mt-auto pt-3" : "ml-auto"} flex items-center justify-end`}>
                      <span className="btn-brutal-sm bg-brutal-pink px-2.5 py-1 text-xs">{formatMessage({ id: "settings.connectedApps.open" })}</span>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}
          <div
            className={connectedAppsCollectionClassName(connectedAppsViewMode)}
            data-testid="connected-apps-marketplace-collection"
            data-view={connectedAppsViewMode}
          >
            {marketplaceApps.map((app) => (
              <button
                key={app.id}
                type="button"
                onClick={() => setSelectedListing(app)}
                className={`w-full border-2 border-black bg-white p-3 text-left shadow-brutal-sm transition-shadow hover:shadow-brutal ${
                  connectedAppsViewMode === "grid" ? "flex h-full flex-col" : "flex items-center gap-3"
                }`}
              >
                <div className="flex items-start gap-3">
                  <ConnectedAppLogo name={app.name} logoUrl={app.logoUrl} seed={app.defaultLogoSeed} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="font-bold text-black">{app.name}</div>
                      <ConnectedAppMarketplaceInstallBadge badge={app.marketplaceInstallBadge} />
                    </div>
                    <div className="mt-0.5 text-xs text-black/55">{formatMessage({ id: "settings.connectedApps.byLine" }, { category: formatMessage({ id: CONNECTED_APP_CATEGORY_LABEL_ID[app.category] ?? "settings.connectedApps.categoryOther" }), developer: app.developer })}</div>
                    {connectedAppsViewMode === "list" && (
                      <ConnectedAppSummary description={app.description} />
                    )}
                  </div>
                </div>
                <div className={`${connectedAppsViewMode === "grid" ? "mt-auto pt-3" : "ml-auto"} flex items-center justify-end gap-2`}>
                  {app.installed ? (
                    <Badge variant="success" uppercase>{formatMessage({ id: "settings.connectedApps.installed" })}</Badge>
                  ) : canManage ? (
                    <span className="btn-brutal-sm bg-brutal-pink px-2.5 py-1 text-xs">{formatMessage({ id: "settings.connectedApps.install" })}</span>
                  ) : (
                    <Badge appearance="outline" uppercase>{formatMessage({ id: "settings.connectedApps.available" })}</Badge>
                  )}
                </div>
              </button>
            ))}
          </div>
          {marketplaceApps.length === 0 && (
            <div className="border-2 border-black bg-white p-6 text-center text-sm text-black/60 shadow-brutal-sm">
              {formatMessage({ id: "settings.connectedApps.noMarketplaceMatch" })}
            </div>
          )}
          <div className="text-center text-xs text-black/55">
            {formatMessage({ id: "settings.connectedApps.reviewNote" })}
          </div>
        </div>
      )}

      {activeTab === "installed" && (
        <div className="space-y-2" data-testid="connected-apps-installed-tab">
          <div
            className={connectedAppsCollectionClassName(connectedAppsViewMode)}
            data-testid="connected-apps-installed-collection"
            data-view={connectedAppsViewMode}
          >
          {filteredInstalledApps.map((app) => (
            <SurfaceListItem
              key={`${app.origin}-${app.id}`}
              interactive={false}
              className={connectedAppsViewMode === "grid"
                ? "flex min-h-[184px] w-full flex-col gap-3"
                : "flex w-full flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"}
            >
              <div className="flex min-w-0 flex-1 items-start gap-3">
                <ConnectedAppLogo name={app.name} logoUrl={app.logoUrl} seed={app.defaultLogoSeed} size="sm" />
                <div className="min-w-0 flex-1">
                  {app.editable ? (
                    <div className="min-w-0 break-words font-bold text-black">{app.name}</div>
                  ) : (
                    <div
                      role="button"
                      tabIndex={0}
                      aria-label={app.name}
                      onClick={() => {
                        setError("");
                        setSelectedInstalledApp(app);
                      }}
                      onKeyDown={(event) => {
                        if (event.key !== "Enter" && event.key !== " " && event.key !== "Spacebar") return;
                        event.preventDefault();
                        setError("");
                        setSelectedInstalledApp(app);
                      }}
                      className="w-fit max-w-full break-words font-bold text-black underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-black"
                    >
                      {app.name}
                    </div>
                  )}
                  <div className="mt-0.5 text-xs text-black/50">
                    <span>{formatMessage({ id: CONNECTED_APP_CATEGORY_LABEL_ID[app.category] ?? "settings.connectedApps.categoryOther" })}</span>
                    <span aria-hidden="true"> · </span>
                    <span>{app.developer}</span>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <ConnectedAppDistributionBadge status={app.publishStatus} />
                    <ConnectedAppOriginBadges app={app} />
                  </div>
                  {connectedAppsViewMode === "list" && (
                    <ConnectedAppSummary description={app.description} />
                  )}
                  {connectedAppsViewMode === "grid" && (
                    <ConnectedAppUrlLink url={app.homepageUrl} label={app.homepageDomain} className="mt-1" />
                  )}
                </div>
              </div>
              {canManage && (app.editable ? (
                <button
                  type="button"
                  onClick={() => {
                    const match = clients.find((client) => client.id === (app.sourceClientId ?? app.id));
                    if (match) beginEditClient(match);
                  }}
                  className={`btn-brutal-sm inline-flex w-fit items-center justify-center gap-1.5 bg-white px-2.5 py-1 text-xs ${connectedAppsViewMode === "grid" ? "mt-auto self-end" : "self-end sm:self-auto"}`}
                >
                  <Pencil size={14} />
                  {formatMessage({ id: "settings.connectedApps.edit" })}
                </button>
              ) : (
                <div className={`flex w-full flex-wrap justify-end gap-2 sm:w-auto ${connectedAppsViewMode === "grid" ? "mt-auto self-end" : "self-end sm:self-auto"}`}>
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      setError("");
                      setMarketplaceUninstallTarget(app);
                    }}
                    disabled={savingClientId === app.id}
                    className="btn-brutal-sm inline-flex items-center justify-center gap-1.5 bg-white px-2.5 py-1 text-xs disabled:opacity-50"
                  >
                    {savingClientId === app.id ? formatMessage({ id: "settings.connectedApps.uninstalling" }) : formatMessage({ id: "settings.connectedApps.uninstall" })}
                  </button>
                </div>
              ))}
            </SurfaceListItem>
          ))}
          </div>
          {filteredInstalledApps.length === 0 && (
            <div className="border-2 border-black bg-white p-6 text-center text-sm text-black/60 shadow-brutal-sm">
              {formatMessage({ id: "settings.connectedApps.noInstalledAppsMatch" })}
            </div>
          )}
        </div>
      )}

      {activeTab === "myapps" && (
        <div className="space-y-3" data-testid="connected-apps-my-apps-tab">
          <div className="text-xs leading-relaxed text-black/60">
            {canManage
              ? formatMessage({ id: "settings.connectedApps.myAppsIntro" })
              : formatMessage({ id: "settings.connectedApps.myAppsReadOnlyIntro" })}
          </div>
          {filteredRegisteredApps.length === 0 ? (
            <div className="border-2 border-black bg-white p-6 text-center text-sm text-black/60 shadow-brutal-sm">
              {registeredApps.length === 0
                ? formatMessage({ id: "settings.connectedApps.noRegisteredApps" })
                : formatMessage({ id: "settings.connectedApps.noRegisteredAppsMatch" })}
            </div>
          ) : (
            <div
              className={connectedAppsCollectionClassName(connectedAppsViewMode)}
              data-testid="connected-apps-my-apps-collection"
              data-view={connectedAppsViewMode}
            >
              {filteredRegisteredApps.map((app) => (
                <SurfaceListItem
                  key={app.id}
                  interactive={false}
                  className={connectedAppsViewMode === "grid"
                    ? "flex min-h-[184px] w-full flex-col gap-3"
                    : "flex w-full flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"}
                >
                  <div className="flex min-w-0 flex-1 items-start gap-3">
                    <ConnectedAppLogo name={app.name} logoUrl={app.logoUrl} seed={app.defaultLogoSeed} size="sm" />
                    <div className="min-w-0 flex-1">
                      <div className="min-w-0 break-words font-bold text-black">{app.name}</div>
                      <div className="mt-0.5 text-xs text-black/50">{formatMessage({ id: CONNECTED_APP_CATEGORY_LABEL_ID[app.category] ?? "settings.connectedApps.categoryOther" })}</div>
                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        <ConnectedAppDistributionBadge status={app.status} />
                      </div>
                      {connectedAppsViewMode === "list" && (
                        <ConnectedAppSummary description={app.description} />
                      )}
                      {connectedAppsViewMode === "grid" && (
                        <>
                          {sourceOwnedConnectedAppStatusHint(app.status) && (
                            <div className="mt-1 line-clamp-2 text-xs leading-relaxed text-black/55" title={formatMessage({ id: sourceOwnedConnectedAppStatusHint(app.status)! })}>
                              {formatMessage({ id: sourceOwnedConnectedAppStatusHint(app.status)! })}
                            </div>
                          )}
                          <ConnectedAppUrlLink url={app.homepageUrl} label={getDomainFromUrl(app.homepageUrl)} className="mt-1" />
                        </>
                      )}
                    </div>
                  </div>
                  {canManage && (
                    <div className={`flex w-full flex-wrap items-center justify-end gap-2 sm:w-auto ${connectedAppsViewMode === "grid" ? "mt-auto" : ""}`}>
                      {canEditSourceOwnedConnectedApp(app.status) && (
                        <button type="button" onClick={() => beginEditClient(app)} className="btn-brutal-sm inline-flex items-center justify-center gap-1.5 bg-white px-2.5 py-1 text-xs">
                          <Pencil size={14} />
                          {formatMessage({ id: "settings.connectedApps.edit" })}
                        </button>
                      )}
                    </div>
                  )}
                </SurfaceListItem>
              ))}
            </div>
          )}
        </div>
      )}

      {selectedInstalledApp && (
        <Modal onClose={() => setSelectedInstalledApp(null)}>
          <div className="w-full max-w-2xl card-brutal space-y-4 p-5">
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 items-start gap-3">
                <ConnectedAppLogo name={selectedInstalledApp.name} logoUrl={selectedInstalledApp.logoUrl} seed={selectedInstalledApp.defaultLogoSeed} size="lg" />
                <div className="min-w-0">
                  <SectionEyebrow as="div">{formatMessage({ id: "settings.connectedApps.installedAppEyebrow" })}</SectionEyebrow>
                  <div className="mt-1 break-words text-xl font-bold text-black">{selectedInstalledApp.name}</div>
                  <div className="mt-0.5 text-xs text-black/55">{selectedInstalledApp.developer}</div>
                </div>
              </div>
              <Button type="button" onClick={() => setSelectedInstalledApp(null)} shape="icon" aria-label={formatMessage({ id: "settings.connectedApps.closeInstalledAppDetail" })}>
                <X size={14} />
              </Button>
            </div>
            {error ? <Banner intent="warning" density="sm" className="font-bold">{error}</Banner> : null}
            <OAuthScopeSummaryPanel
              title={formatMessage({ id: "settings.connectedApps.loginAccessTitle" })}
              description={formatMessage({ id: "settings.connectedApps.loginAccessDescription" })}
              scopes={selectedInstalledApp.grantedScopes}
              defaultToDeclared={false}
            />
            <InstalledAppNotifications
              clientId={selectedInstalledApp.id}
              canManage={canManage}
              onError={setError}
            />
            <div className="flex justify-end border-t-2 border-black pt-4">
              <Button type="button" onClick={() => setSelectedInstalledApp(null)} size="md">{formatMessage({ id: "settings.common.close" })}</Button>
            </div>
          </div>
        </Modal>
      )}

      {selectedListing && (
        <Modal onClose={() => setSelectedListing(null)}>
          <div className="w-full max-w-2xl card-brutal space-y-4 p-5" aria-labelledby="connected-app-detail-title">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-3">
                <ConnectedAppLogo name={selectedListing.name} logoUrl={selectedListing.logoUrl} seed={selectedListing.defaultLogoSeed} size="lg" />
                <div>
                  <SectionEyebrow as="div">{formatMessage({ id: "settings.connectedApps.appDetail" })}</SectionEyebrow>
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    <h2 id="connected-app-detail-title" className="text-xl font-bold text-black">{selectedListing.name}</h2>
                    <ConnectedAppMarketplaceInstallBadge badge={selectedListing.marketplaceInstallBadge} />
                  </div>
                  <div className="mt-0.5 text-xs text-black/55">{formatMessage({ id: "settings.connectedApps.byLine" }, { category: formatMessage({ id: CONNECTED_APP_CATEGORY_LABEL_ID[selectedListing.category] ?? "settings.connectedApps.categoryOther" }), developer: selectedListing.developer })}</div>
                </div>
              </div>
              <Button type="button" onClick={() => setSelectedListing(null)} shape="icon" aria-label={formatMessage({ id: "settings.connectedApps.closeAppDetail" })}>
                <X size={14} />
              </Button>
            </div>
            <ConnectedAppsErrorBanner surface={connectedAppsErrorSurface} target={CONNECTED_APPS_ERROR_LISTING} error={error} />
            <ConnectedAppDetailSection title={formatMessage({ id: "settings.connectedApps.section.profile" })}>
              <p className="mb-2 text-sm leading-relaxed text-black/70">{selectedListing.description}</p>
              <div className="divide-y-2 divide-black/10 text-sm">
                <ConnectedAppDetailRow label={formatMessage({ id: "settings.connectedApps.publisher" })}>
                  {selectedListing.developer}
                </ConnectedAppDetailRow>
                <ConnectedAppDetailRow label={formatMessage({ id: "settings.connectedApps.homepageUrlLabel" })}>
                  {selectedListing.homepageUrl ? (
                    <ConnectedAppUrlLink url={selectedListing.homepageUrl} />
                  ) : (
                    <span className="break-all font-mono text-xs font-bold text-black">{selectedListing.homepageDomain}</span>
                  )}
                </ConnectedAppDetailRow>
                <ConnectedAppDetailRow label={formatMessage({ id: "settings.connectedApps.redirectCallback" })}>
                  <span className="break-all font-mono text-xs font-bold text-black">{selectedListing.callbackDomain}</span>
                </ConnectedAppDetailRow>
              </div>
            </ConnectedAppDetailSection>
            <ConnectedAppDetailSection
              title={formatMessage({ id: "settings.connectedApps.section.loginWithRaft" })}
              description={formatMessage({ id: "settings.connectedApps.detail.loginDescription" })}
              tone="cream"
            >
              <OAuthScopeSummaryPanel
                title={formatMessage({ id: "settings.connectedApps.detail.requestableDeclared" })}
                scopes={selectedListing.allowedScopes}
              />
            </ConnectedAppDetailSection>
            <ConnectedAppDetailSection title={formatMessage({ id: "settings.connectedApps.section.appNotifications" })} tone="cream">
              <AppNotificationRequestSummary
                groups={selectedListing.appNotificationGroups}
                events={selectedListing.appNotificationEvents}
                reviewPending={selectedListing.appNotificationReviewPending}
              />
            </ConnectedAppDetailSection>
            <ConnectedAppDetailSection title={formatMessage({ id: "settings.connectedApps.section.distribution" })} tone="cream">
              <div className="text-xs leading-relaxed text-black/70">
                {formatMessage({ id: "settings.connectedApps.listingReviewNote" })}
              </div>
            </ConnectedAppDetailSection>
            {canManage && selectedListing.installed && (
              <ConnectedAppDetailSection title={formatMessage({ id: "settings.connectedApps.section.dangerZone" })}>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="text-xs leading-relaxed text-black/60">
                    {formatMessage({ id: "settings.connectedApps.detail.removeInstalledDescription" })}
                  </div>
                  <Button
                    type="button"
                    disabled={savingClientId === selectedListing.id}
                    onClick={() => {
                      setError("");
                      setMarketplaceUninstallTarget(selectedListing);
                    }}
                    tone="red"
                    size="md"
                  >
                    {savingClientId === selectedListing.id ? formatMessage({ id: "settings.connectedApps.uninstalling" }) : formatMessage({ id: "settings.connectedApps.uninstallFromServer" })}
                  </Button>
                </div>
              </ConnectedAppDetailSection>
            )}
            <div className="flex items-center justify-end gap-2 border-t-2 border-black pt-4">
              <Button type="button" onClick={() => setSelectedListing(null)} size="md">
                {canManage ? formatMessage({ id: "settings.common.cancel" }) : formatMessage({ id: "settings.common.close" })}
              </Button>
              {canManage && !selectedListing.installed && (
                <Button
                  type="button"
                  disabled={savingClientId === selectedListing.id}
                  onClick={() => void handleInstallMarketplaceApp(selectedListing)}
                  tone="pink"
                  size="md"
                >
                  {savingClientId === selectedListing.id ? formatMessage({ id: "settings.connectedApps.installing" }) : formatMessage({ id: "settings.connectedApps.installToServer" })}
                </Button>
              )}
            </div>
          </div>
        </Modal>
      )}

      {selectedBuiltInApp && (
        <Modal onClose={() => setSelectedBuiltInApp(null)}>
          <div className="w-full max-w-2xl card-brutal space-y-4 p-5" aria-labelledby="connected-built-in-app-detail-title">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-3">
                <ConnectedAppLogo name={selectedBuiltInApp.name} logoUrl={selectedBuiltInApp.logoUrl} seed={selectedBuiltInApp.defaultLogoSeed} size="lg" />
                <div>
                  <SectionEyebrow as="div">{formatMessage({ id: "settings.connectedApps.builtInApp" })}</SectionEyebrow>
                  <h2 id="connected-built-in-app-detail-title" className="mt-1 text-xl font-bold text-black">{selectedBuiltInApp.name}</h2>
                  <div className="mt-0.5 text-xs text-black/55">{formatMessage({ id: "settings.connectedApps.builtInAvailableNoInstall" })}</div>
                </div>
              </div>
              <Button type="button" onClick={() => setSelectedBuiltInApp(null)} shape="icon" aria-label={formatMessage({ id: "settings.connectedApps.closeBuiltInDetail" })}>
                <X size={14} />
              </Button>
            </div>
            <ConnectedAppDetailSection title={formatMessage({ id: "settings.connectedApps.section.profile" })}>
              {selectedBuiltInApp.description && (
                <p className="mb-2 text-sm leading-relaxed text-black/70">{selectedBuiltInApp.description}</p>
              )}
              <div className="divide-y-2 divide-black/10 text-sm">
                <ConnectedAppDetailRow label={formatMessage({ id: "settings.connectedApps.publisher" })}>
                  {formatMessage({ id: "brand.productName" })}
                </ConnectedAppDetailRow>
                <ConnectedAppDetailRow label={formatMessage({ id: "settings.connectedApps.homepageUrlLabel" })}>
                  {selectedBuiltInApp.homepageUrl ? (
                    <ConnectedAppUrlLink url={selectedBuiltInApp.homepageUrl} />
                  ) : (
                    <span className="break-all font-mono text-xs font-bold text-black">{selectedBuiltInApp.homepageDomain ?? formatMessage({ id: "settings.connectedApps.notConfigured" })}</span>
                  )}
                </ConnectedAppDetailRow>
              </div>
            </ConnectedAppDetailSection>
            <ConnectedAppDetailSection
              title={formatMessage({ id: "settings.connectedApps.section.loginWithRaft" })}
              description={formatMessage({ id: "settings.connectedApps.detail.builtInLoginDescription" })}
              tone="cream"
            >
              <OAuthScopeSummaryPanel
                title={formatMessage({ id: "settings.connectedApps.detail.requestableDeclared" })}
                scopes={selectedBuiltInApp.allowedScopes}
              />
            </ConnectedAppDetailSection>
            <ConnectedAppDetailSection title={formatMessage({ id: "settings.connectedApps.section.distribution" })} tone="cream">
              <div className="text-xs leading-relaxed text-black/70">
                {formatMessage({ id: "settings.connectedApps.builtInFirstParty" })}
              </div>
            </ConnectedAppDetailSection>
            <div className="flex items-center justify-end gap-2 border-t-2 border-black pt-4">
              <Button type="button" onClick={() => setSelectedBuiltInApp(null)} size="md">{formatMessage({ id: "settings.common.close" })}</Button>
              <Button
                type="button"
                disabled={!selectedBuiltInApp.homepageUrl}
                onClick={() => openBuiltInApp(selectedBuiltInApp)}
                tone="pink"
                size="md"
              >
                {formatMessage({ id: "settings.connectedApps.open" })}
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {canManage && showRegisterDrawer && (
        <Modal onClose={closeRegisterDrawer}>
          <form
            onSubmit={handleSaveClient}
            className="card-brutal flex h-[min(52rem,calc(100dvh-2rem))] max-h-[calc(100dvh-2rem)] w-full max-w-5xl flex-col overflow-hidden bg-white"
            aria-labelledby="connected-app-form-title"
            data-testid="connected-app-editor"
          >
            <div className="flex flex-col gap-3 border-b-2 border-black bg-brutal-cream px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex min-w-0 items-center gap-3">
                <ConnectedAppLogo
                  name={clientName || editingClient?.name || "App"}
                  logoUrl={editingClient?.logoUrl}
                  seed={clientId || editingClient?.clientId || "new-app"}
                />
                <div className="min-w-0">
                  <SectionEyebrow as="div">{editingClient ? formatMessage({ id: "settings.connectedApps.editApp" }) : formatMessage({ id: "settings.connectedApps.registerApp" })}</SectionEyebrow>
                  <h2 id="connected-app-form-title" className="mt-0.5 truncate text-xl font-black text-black">
                    {editingClient ? editingClient.name : formatMessage({ id: "settings.connectedApps.newConnectedApp" })}
                  </h2>
                  <p className="mt-0.5 text-xs text-black/55">{formatMessage({ id: "settings.connectedApps.editor.headerDescription" })}</p>
                </div>
              </div>
              <div className="flex shrink-0 items-center justify-end gap-2">
                <Button
                  type="button"
                  onClick={closeRegisterDrawer}
                  size="sm"
                  shape="icon"
                  aria-label={formatMessage({ id: "settings.connectedApps.closeAppForm" })}
                >
                  <X size={16} />
                </Button>
                <Button type="submit" disabled={submitting || appNotificationLoading || savingClientId === editingClient?.id} tone="pink" size="sm">
                  {submitting ? formatMessage({ id: "settings.common.saving" }) : editingClient ? formatMessage({ id: "settings.common.save" }) : formatMessage({ id: "settings.connectedApps.registerApp" })}
                </Button>
              </div>
            </div>
            {(error || createdSecret) && (
              <div className="space-y-2 border-b-2 border-black bg-white px-4 py-3">
                <ConnectedAppsErrorBanner surface={connectedAppsErrorSurface} target={CONNECTED_APPS_ERROR_FORM} error={error} />
                {renderClientSecretReveal()}
              </div>
            )}

            <div className="grid min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)] md:grid-cols-[220px_minmax(0,1fr)] md:grid-rows-1">
              <nav
                ref={appEditorRailRef}
                className="flex gap-2 overflow-x-auto border-b-2 border-black bg-brutal-cream p-3 md:block md:space-y-2 md:overflow-y-auto md:border-b-0 md:border-r-2"
                aria-label={formatMessage({ id: "settings.connectedApps.appEditorSectionsAriaLabel" })}
                data-testid="connected-app-editor-rail"
              >
                {appEditorSections.map((section) => (
                  <button
                    key={section.id}
                    type="button"
                    data-app-editor-section={section.id}
                    onClick={() => scrollToAppEditorSection(section.id)}
                    aria-current={appEditorSection === section.id ? "true" : undefined}
                    className={`min-w-[155px] border-2 border-black px-3 py-2 text-left md:min-w-0 md:w-full ${
                      appEditorSection === section.id ? "bg-soft-signal shadow-brutal-sm" : "bg-white"
                    }`}
                  >
                    <span className="flex items-center gap-2 text-xs font-black text-black">
                      {section.icon}
                      {section.label}
                    </span>
                    <span className="mt-1 block truncate text-[10px] font-bold text-black/50">{section.status}</span>
                  </button>
                ))}
              </nav>
              <div
                ref={appEditorContentRef}
                onScroll={syncAppEditorSectionFromScroll}
                className="min-h-0 space-y-4 overflow-y-auto bg-white p-4"
                data-testid="connected-app-editor-content"
              >

            <ConnectedAppEditorSection
              sectionId="profile"
              title={formatMessage({ id: "settings.connectedApps.section.profile" })}
              description={formatMessage({ id: "settings.connectedApps.editor.profileDescription" })}
              status={profileStatus}
            >
            <div className="grid gap-4 sm:grid-cols-[140px_minmax(0,1fr)]">
              <div>
                <FormField
                  label={formatMessage({ id: "settings.connectedApps.logoLabel" })}
                  labelStyle="plain"
                  size="compact"
                  hint={editingClient ? formatMessage({ id: "settings.connectedApps.logoHintEdit" }) : formatMessage({ id: "settings.connectedApps.logoHintNew" })}
                >
                  <div className="space-y-2">
                    <div className="flex h-[120px] w-[120px] items-center justify-center border-2 border-dashed border-black bg-brutal-cream">
                      <ConnectedAppLogo
                        name={clientName || editingClient?.name || "App"}
                        logoUrl={editingClient?.logoUrl}
                        seed={clientId || editingClient?.clientId || "new-app"}
                        size="lg"
                      />
                    </div>
                    {editingClient && (
                      <div className="flex flex-wrap gap-2">
                        <input
                          ref={logoInputRef}
                          type="file"
                          accept="image/png,image/jpeg,image/gif,image/webp"
                          className="hidden"
                          onChange={handleLogoFileChange}
                        />
                        <Button
                          type="button"
                          onClick={() => logoInputRef.current?.click()}
                          disabled={logoUploading}
                          size="sm"
                          shape="iconText"
                        >
                          <Upload size={14} />
                          {logoUploading ? formatMessage({ id: "settings.connectedApps.uploading" }) : editingClient.logoUrl ? formatMessage({ id: "settings.connectedApps.change" }) : formatMessage({ id: "settings.connectedApps.upload" })}
                        </Button>
                        {editingClient.logoUrl && (
                          <Button
                            type="button"
                            onClick={() => void handleClearLogo()}
                            disabled={logoUploading}
                            size="sm"
                          >
                            {formatMessage({ id: "settings.connectedApps.reset" })}
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                </FormField>
              </div>
              <div className="space-y-3">
                <FormField label={formatMessage({ id: "settings.connectedApps.appNameLabel" })} labelStyle="plain" size="compact">
                  <input
                    type="text"
                    value={clientName}
                    onChange={(event) => setClientName(event.target.value)}
                    className="input-brutal w-full text-sm"
                    placeholder={formatMessage({ id: "settings.connectedApps.appNamePlaceholder" })}
                    required
                  />
                </FormField>
                <FormField label={formatMessage({ id: "settings.connectedApps.homepageUrlFieldLabel" })} labelStyle="plain" size="compact">
                  <input
                    type="url"
                    value={clientHomepageUrl}
                    onChange={(event) => setClientHomepageUrl(event.target.value)}
                    className="input-brutal w-full text-sm"
                    placeholder="https://example.com"
                  />
                </FormField>
                <FormField label={formatMessage({ id: "settings.connectedApps.categoryLabel" })} labelStyle="plain" size="compact">
                  <Select
                    value={clientCategory}
                    onValueChange={(value) => {
                      if (value == null) return;
                      setClientCategory(value as ConnectedAppCategory);
                    }}
                    items={CONNECTED_APP_PUBLISH_CATEGORY_OPTIONS.map((option) => ({
                      value: option.value,
                      label: formatMessage({ id: CONNECTED_APP_CATEGORY_LABEL_ID[option.value] }),
                    }))}
                  >
                    <SelectTrigger className="w-full" aria-label={formatMessage({ id: "settings.connectedApps.appCategoryAriaLabel" })}>
                      <SelectValue placeholder={formatMessage({ id: "settings.connectedApps.categoryLabel" })} />
                      <SelectIcon />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectList>{renderSelectItems(CONNECTED_APP_PUBLISH_CATEGORY_OPTIONS.map((option) => ({
                        value: option.value,
                        label: formatMessage({ id: CONNECTED_APP_CATEGORY_LABEL_ID[option.value] }),
                      })))}</SelectList>
                    </SelectContent>
                  </Select>
                </FormField>
              </div>
            </div>
            <FormField label={formatMessage({ id: "settings.connectedApps.descriptionLabel" })} labelStyle="plain" size="compact">
              <Textarea
                value={clientDescription}
                onChange={(event) => setClientDescription(event.target.value)}
                rows={3}
                placeholder={formatMessage({ id: "settings.connectedApps.descriptionPlaceholder" })}
                className="resize-none"
              />
            </FormField>
            </ConnectedAppEditorSection>

            <ConnectedAppEditorSection
              sectionId="login"
              title={formatMessage({ id: "settings.connectedApps.section.loginWithRaft" })}
              description={formatMessage({ id: "settings.connectedApps.editor.loginDescription" })}
              status={loginStatus}
            >
            <FormField label={formatMessage({ id: "settings.connectedApps.clientIdLabel" })} labelStyle="plain" size="compact" hint={formatMessage({ id: "settings.connectedApps.clientIdHint" })} optional>
              <input
                type="text"
                value={clientId}
                onChange={(event) => setClientId(event.target.value)}
                className="input-brutal w-full font-mono text-sm disabled:bg-black/5 disabled:text-black/45"
                placeholder={formatMessage({ id: "settings.connectedApps.clientIdPlaceholder" })}
                disabled={!!editingClient}
              />
            </FormField>
            <FormField label={formatMessage({ id: "settings.connectedApps.returnUrlLabel" })} labelStyle="plain" size="compact">
              <input
                type="url"
                value={clientReturnUrl}
                onChange={(event) => setClientReturnUrl(event.target.value)}
                className="input-brutal w-full text-sm"
                placeholder="https://example.com/login/callback"
              />
            </FormField>
            <FormField label={formatMessage({ id: "settings.connectedApps.agentManifestLabel" })} labelStyle="plain" size="compact" optional>
              <input
                type="url"
                value={clientAgentManifestUrl}
                onChange={(event) => setClientAgentManifestUrl(event.target.value)}
                className="input-brutal w-full text-sm"
                placeholder="https://example.com/.well-known/raft-agent-manifest.json"
              />
            </FormField>
            <DeclaredScopesPicker value={clientAllowedScopes} onChange={setClientAllowedScopes} />
            </ConnectedAppEditorSection>
            <ConnectedAppEditorSection
              sectionId="notifications"
              title={<AppNotificationsLabel />}
              description={formatMessage({ id: "settings.connectedApps.editor.notificationsDescription" })}
              status={notificationsStatus}
            >
            <DeveloperAppNotifications
              embedded
              clientId={editingClient?.id ?? null}
              value={appNotificationSelection}
              onChange={setAppNotificationSelection}
              state={appNotificationState}
              loading={appNotificationLoading}
              onConfigurationOpenChange={setAppNotificationConfigurationOpen}
              onStateChange={(next) => {
                setAppNotificationState(next);
                const requested = next.pending_revision ?? { groups: next.current_groups, events: next.current_events };
                setAppNotificationSelection({ groups: requested.groups, events: requested.events });
              }}
              onError={setError}
            />
            </ConnectedAppEditorSection>
            <ConnectedAppEditorSection
              sectionId="distribution"
              title={formatMessage({ id: "settings.connectedApps.section.distribution" })}
              description={formatMessage({ id: "settings.connectedApps.editor.distributionDescription" })}
              status={distributionStatus}
            >
            {!editingClient ? (
              <div className="border-l-4 border-black/30 bg-brutal-cream px-3 py-2 text-xs font-bold text-black/60">
                {formatMessage({ id: "settings.connectedApps.saveBeforeShareOrReview" })}
              </div>
            ) : null}
            {editingClient && sourceOwnedConnectedAppStatusHint(editingClient.publishStatus) ? (
              <div className="border-l-4 border-soft-signal bg-soft-signal/20 px-3 py-2 text-xs leading-relaxed text-black/70">
                {formatMessage({ id: sourceOwnedConnectedAppStatusHint(editingClient.publishStatus)! })}
              </div>
            ) : null}
            {editingClient && (editingClient.publishStatus === "private" || editingClient.publishStatus === "rejected") && (
              <div className="border-2 border-black bg-white p-3 shadow-brutal-sm" data-testid="connected-app-private-share-card">
                <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                  <div>
                    <SectionEyebrow as="div">{formatMessage({ id: "settings.connectedApps.privateShareTitle" })}</SectionEyebrow>
                    <div className="mt-1 text-xs leading-relaxed text-black/60">
                      {formatMessage({ id: "settings.connectedApps.privateShareDesc" })}
                    </div>
                    {shareLink && (
                      <div className="mt-2 text-xs text-black/55">
                        {formatMessage({ id: "settings.connectedApps.activeLinkExpires" }, { when: shareLink.expiresAt ? formatDate(shareLink.expiresAt) : formatMessage({ id: "settings.connectedApps.never" }) })}
                      </div>
                    )}
                  </div>
                  <div className="flex flex-wrap justify-end gap-2">
                    <Button type="button" size="sm" onClick={() => void handleCreateShareLink()} disabled={shareLoading}>
                      {shareLoading ? formatMessage({ id: "settings.connectedApps.working" }) : shareLink ? formatMessage({ id: "settings.connectedApps.regenerate" }) : formatMessage({ id: "settings.connectedApps.createLink" })}
                    </Button>
                    {shareLink && (
                      <Button type="button" size="sm" onClick={() => void handleRevokeShareLink()} disabled={shareLoading}>
                        {formatMessage({ id: "settings.connectedApps.revoke" })}
                      </Button>
                    )}
                  </div>
                </div>
                {shareUrl && (
                  <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
                    <input
                      type="text"
                      readOnly
                      value={shareUrl}
                      className="input-brutal min-w-0 flex-1 font-mono text-xs"
                      aria-label={formatMessage({ id: "settings.connectedApps.privateShareUrlAria" })}
                    />
                    <Button type="button" size="sm" shape="iconText" onClick={() => void handleCopyShareUrl()}>
                      {shareCopied ? <Check size={14} /> : <Copy size={14} />}
                      {shareCopied ? formatMessage({ id: "settings.connectedApps.copied" }) : formatMessage({ id: "settings.connectedApps.copy" })}
                    </Button>
                  </div>
                )}
              </div>
            )}
            {editingClient && (editingClient.publishStatus === "private" || editingClient.publishStatus === "rejected") && (
              <div className="border-2 border-black bg-brutal-cream p-3 shadow-brutal-sm">
                <SectionEyebrow as="div">{formatMessage({ id: "settings.connectedApps.publishRequestTitle" })}</SectionEyebrow>
                <div className="mt-1 text-xs leading-relaxed text-black/60">
                  {formatMessage({ id: "settings.connectedApps.distributionMetadataNote" })}
                </div>
                <div className="mt-3 flex justify-end">
                  <Button
                    type="button"
                    onClick={() => void handleRequestPublish(mapClientToRegisteredApp(editingClient))}
                    disabled={savingClientId === editingClient.id}
                    tone="pink"
                    size="sm"
                  >
                    {savingClientId === editingClient.id ? formatMessage({ id: "settings.connectedApps.requesting" }) : formatMessage({ id: "settings.connectedApps.requestPublish" })}
                  </Button>
                </div>
              </div>
            )}
            {editingClient?.publishStatus === "published" ? (
              <div className="border-l-4 border-brutal-lime bg-brutal-lime/15 px-3 py-2 text-xs leading-relaxed text-black/70">
                {formatMessage({ id: "settings.connectedApps.publishedMarketplaceNote" })}
              </div>
            ) : null}
            </ConnectedAppEditorSection>

            <ConnectedAppEditorSection
              sectionId="danger"
              title={formatMessage({ id: "settings.connectedApps.section.dangerZone" })}
              description={formatMessage({ id: "settings.connectedApps.editor.dangerDescription" })}
              status={formatMessage({ id: editingClient
                ? "settings.connectedApps.editor.dangerStatusRestricted"
                : "settings.connectedApps.editor.dangerStatusAvailableAfterSave" })}
              tone="warning"
            >
              {!editingClient ? (
                <div className="text-xs font-bold leading-relaxed text-black/55">{formatMessage({ id: "settings.connectedApps.editor.saveBeforeLifecycle" })}</div>
              ) : (
                <>
                  <div className="flex flex-col gap-3 border-2 border-black/20 bg-white p-3 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <SectionEyebrow as="div">{formatMessage({ id: "settings.connectedApps.editor.clientSecretTitle" })}</SectionEyebrow>
                      <div className="mt-1 text-xs leading-relaxed text-black/60">
                        {formatMessage({ id: "settings.connectedApps.editor.clientSecretDescription" })}
                      </div>
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      tone="yellow"
                      onClick={() => setRegenerateSecretTarget(editingClient)}
                      disabled={submitting || regeneratingClientId === editingClient.id}
                      data-testid="connected-app-regenerate-secret-button"
                    >
                      {formatMessage({ id: regeneratingClientId === editingClient.id
                        ? "settings.connectedApps.editor.regeneratingClientSecret"
                        : "settings.connectedApps.editor.regenerateClientSecret" })}
                    </Button>
                  </div>
                  {canRequestOfflineSourceOwnedConnectedApp(editingClient.publishStatus) ? (
                    <div className="flex flex-col gap-3 border-2 border-black/20 bg-white p-3 sm:flex-row sm:items-start sm:justify-between">
                      <div>
                        <SectionEyebrow as="div">{formatMessage({ id: "settings.connectedApps.editor.marketplaceLifecycleTitle" })}</SectionEyebrow>
                        <div className="mt-1 text-xs leading-relaxed text-black/60">{formatMessage({ id: "settings.connectedApps.editor.marketplaceLifecycleDescription" })}</div>
                      </div>
                      <Button type="button" size="sm" onClick={() => setOfflineRequestTarget(mapClientToRegisteredApp(editingClient))}>
                        {formatMessage({ id: "settings.connectedApps.editor.requestOffline" })}
                      </Button>
                    </div>
                  ) : null}
                  {canDeleteSourceOwnedConnectedApp(editingClient.publishStatus) ? (
                    <DangerActionCard
                      testId="connected-app-delete-card"
                      title={formatMessage({ id: "settings.connectedApps.deleteApp" })}
                      description={formatMessage({ id: "settings.connectedApps.deleteAppDescription" })}
                      actionLabel={formatMessage({ id: "settings.connectedApps.delete" })}
                      actionIcon={<Trash2 size={14} />}
                      actionSize="sm"
                      onAction={() => setDeleteClientTarget(mapClientToRegisteredApp(editingClient))}
                    />
                  ) : null}
                </>
              )}
            </ConnectedAppEditorSection>
              </div>
            </div>
          </form>
        </Modal>
      )}

      {canManage && deleteClientTarget && (
        <ConfirmDialog
          chromeLocale="active"
          title={formatMessage({ id: "settings.connectedApps.deleteAppTitle" }, { name: deleteClientTarget.name })}
          message={(
            <>
              {formatMessage({ id: "settings.connectedApps.deleteAppMessagePrefix" })}
              <code className="font-mono font-bold">{deleteClientTarget.clientId}</code>
              {formatMessage({ id: "settings.connectedApps.deleteAppMessageSuffix" })}
            </>
          )}
          confirmLabel={formatMessage({ id: "settings.connectedApps.deleteApp" })}
          loadingLabel={formatMessage({ id: "settings.connectedApps.deleting" })}
          confirmIcon={<Trash2 size={14} />}
          confirmTestId="connected-app-delete-confirm-button"
          layer={showRegisterDrawer ? 1 : undefined}
          onClose={() => setDeleteClientTarget(null)}
          onConfirm={() => handleDeleteClient(deleteClientTarget)}
        />
      )}

      {canManage && regenerateSecretTarget && (
        <ConfirmDialog
          title={formatMessage(
            { id: "settings.connectedApps.editor.regenerateSecretConfirmTitle" },
            { name: regenerateSecretTarget.name },
          )}
          message={formatMessage(
            { id: "settings.connectedApps.editor.regenerateSecretConfirmMessage" },
            {
              clientId: regenerateSecretTarget.clientId,
              code: (chunks) => <code key="client-id" className="font-mono font-bold">{chunks}</code>,
            },
          )}
          confirmLabel={formatMessage({ id: "settings.connectedApps.editor.regenerateSecretConfirmLabel" })}
          loadingLabel={formatMessage({ id: "settings.connectedApps.editor.regeneratingClientSecret" })}
          confirmIcon={<AlertTriangle size={14} />}
          confirmColor="bg-soft-signal"
          confirmTestId="connected-app-regenerate-secret-confirm-button"
          layer={1}
          onClose={() => setRegenerateSecretTarget(null)}
          onConfirm={() => handleRegenerateClientSecret(regenerateSecretTarget)}
        />
      )}

      {canManage && offlineRequestTarget && (
        <ConfirmDialog
          title={formatMessage(
            { id: "settings.connectedApps.editor.requestOfflineConfirmTitle" },
            { name: offlineRequestTarget.name },
          )}
          message={formatMessage(
            { id: "settings.connectedApps.editor.requestOfflineConfirmMessage" },
            {
              clientId: offlineRequestTarget.clientId,
              code: (chunks) => <code key="client-id" className="font-mono font-bold">{chunks}</code>,
            },
          )}
          confirmLabel={formatMessage({ id: "settings.connectedApps.editor.requestOffline" })}
          loadingLabel={formatMessage({ id: "settings.connectedApps.editor.requestOfflineConfirmLoading" })}
          confirmIcon={<Upload size={14} className="rotate-180" />}
          layer={showRegisterDrawer ? 1 : undefined}
          onClose={() => setOfflineRequestTarget(null)}
          onConfirm={() => handleRequestOffline(offlineRequestTarget)}
        />
      )}

      {canManage && marketplaceUninstallTarget && (
        <ConfirmDialog
          chromeLocale="active"
          title={formatMessage({ id: "settings.connectedApps.uninstallAppTitle" }, { name: marketplaceUninstallTarget.name })}
          message={(
            <>
              {formatMessage({ id: "settings.connectedApps.uninstallMessagePrefix" })}
              <code className="font-mono font-bold">{marketplaceUninstallTarget.clientId}</code>
              {formatMessage({ id: "settings.connectedApps.uninstallMessageSuffix" })}
            </>
          )}
          confirmLabel={formatMessage({ id: "settings.connectedApps.uninstallApp" })}
          loadingLabel={formatMessage({ id: "settings.connectedApps.uninstallingConfirm" })}
          confirmIcon={<Trash2 size={14} />}
          confirmTestId="connected-app-uninstall-confirm-button"
          layer={selectedListing?.id === marketplaceUninstallTarget.id ? 1 : undefined}
          onClose={() => setMarketplaceUninstallTarget(null)}
          onConfirm={() => handleUninstallMarketplaceApp(marketplaceUninstallTarget)}
        />
      )}
    </div>
  );
}

function PreJoinAgreementSection() {
  const { formatMessage } = useIntl();
  const currentServer = useServerStore((s) => s.current);
  const [enabled, setEnabled] = useState(false);
  const [title, setTitle] = useState("");
  const [bodyMarkdown, setBodyMarkdown] = useState("");
  const [savedEnabled, setSavedEnabled] = useState(false);
  const [savedTitle, setSavedTitle] = useState("");
  const [savedBodyMarkdown, setSavedBodyMarkdown] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  // oxlint-disable react-hooks/exhaustive-deps -- load the agreement only when the active server id changes; depending on the whole `currentServer` store object would refetch on unrelated server-store churn.
  // Async-loader: load agreement on server change. Same FP family as L1696.
  // oxlint-disable-next-line react-doctor/no-cascading-set-state
  useEffect(() => {
    if (!currentServer) return;
    let cancelled = false;
    // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change
    setLoading(true);
    // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change
    setError("");
    void api
      .get(`/servers/${currentServer.id}/agreement`)
      .then(({ data }) => {
        if (cancelled) return;
        const nextEnabled = !!data.enabled;
        const nextTitle = data.agreement?.title ?? "";
        const nextBodyMarkdown = data.agreement?.bodyMarkdown ?? "";
        setEnabled(nextEnabled);
        setTitle(nextTitle);
        setBodyMarkdown(nextBodyMarkdown);
        setSavedEnabled(nextEnabled);
        setSavedTitle(nextTitle);
        setSavedBodyMarkdown(nextBodyMarkdown);
        setSaved(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const responseError = (err as { response?: { data?: { error?: unknown } } }).response?.data?.error;
        setError(
          typeof responseError === "string" && responseError.trim()
            ? responseError
            : formatMessage({ id: "settings.preJoinAgreement.failedLoad" }),
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [currentServer?.id]);
  // oxlint-enable react-hooks/exhaustive-deps

  if (!currentServer) return null;

  const dirty =
    enabled !== savedEnabled
    || title !== savedTitle
    || bodyMarkdown !== savedBodyMarkdown;
  const bodyMarkdownTooLong = bodyMarkdown.length > PRE_JOIN_AGREEMENT_BODY_MAX_LENGTH;
  const bodyMarkdownError = bodyMarkdownTooLong
    ? formatMessage({ id: "settings.preJoinAgreement.bodyTooLong" }, { max: PRE_JOIN_AGREEMENT_BODY_MAX_LENGTH_LABEL })
    : "";

  const handleSave = async () => {
    if (bodyMarkdownTooLong) return;
    setSaving(true);
    setSaved(false);
    setError("");
    try {
      const { data } = await api.put(`/servers/${currentServer.id}/agreement`, {
        enabled,
        title,
        bodyMarkdown,
      });
      const nextEnabled = !!data.enabled;
      const nextTitle = data.agreement?.title ?? title;
      const nextBodyMarkdown = data.agreement?.bodyMarkdown ?? bodyMarkdown;
      setEnabled(nextEnabled);
      setTitle(nextTitle);
      setBodyMarkdown(nextBodyMarkdown);
      setSavedEnabled(nextEnabled);
      setSavedTitle(nextTitle);
      setSavedBodyMarkdown(nextBodyMarkdown);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1500);
    } catch (err: any) {
      setError(err.response?.data?.error || formatMessage({ id: "settings.preJoinAgreement.failedSave" }));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mb-6">
      <SectionHeader
        className="mb-3"
        icon={<FileText size={16} />}
        label={formatMessage({ id: "settings.preJoinAgreement.sectionLabel" })}
      />

      <div className="border-2 border-black bg-white shadow-brutal-sm p-4 space-y-4">
        <label className={`flex items-start gap-3 ${saving || loading ? "opacity-60" : ""}`}>
          <Checkbox
            size="md"
            checked={enabled}
            disabled={saving || loading}
            onChange={(event) => {
              setEnabled(event.currentTarget.checked);
              setSaved(false);
            }}
            className="mt-0.5"
          />
          <span className="min-w-0">
            <span className="block text-sm font-bold text-black">{formatMessage({ id: "settings.preJoinAgreement.requireTitle" })}</span>
            <span className="block text-xs text-black/60 mt-0.5">
              {formatMessage({ id: "settings.preJoinAgreement.requireDescription" })}
            </span>
          </span>
        </label>

        {enabled && (
          <>
            <FormField label={formatMessage({ id: "settings.preJoinAgreement.titleLabel" })} labelStyle="plain" size="compact">
              <input
                value={title}
                onChange={(event) => {
                  setTitle(event.target.value);
                  setSaved(false);
                }}
                maxLength={160}
                disabled={saving || loading}
                className="w-full border-2 border-black p-2 text-sm shadow-brutal-sm focus:shadow-brutal focus:outline-none disabled:opacity-60"
              />
            </FormField>
            <FormField label={formatMessage({ id: "settings.preJoinAgreement.bodyLabel" })} labelStyle="plain" size="compact">
              <Textarea
                value={bodyMarkdown}
                onChange={(event) => {
                  setBodyMarkdown(event.target.value);
                  setSaved(false);
                }}
                rows={7}
                limit={PRE_JOIN_AGREEMENT_BODY_MAX_LENGTH}
                showCounter
                error={bodyMarkdownError}
                disabled={saving || loading}
                className="resize-y font-mono text-xs disabled:opacity-60"
              />
            </FormField>
            <div className="border-2 border-black/30 bg-brutal-cream p-3">
              <div className="mb-2 text-[11px] font-bold uppercase tracking-widest text-black/50">{formatMessage({ id: "settings.preJoinAgreement.preview" })}</div>
              <div className="text-sm">
                <AgreementBody source={bodyMarkdown} />
              </div>
            </div>
          </>
        )}

        {error && (
          <Banner intent="warning" density="sm" className="font-bold">
            {error}
          </Banner>
        )}

        <div className="flex flex-col items-start gap-2">
          <div className="text-[11px] text-black/50">
            {formatMessage({ id: "settings.preJoinAgreement.versionNote" })}
          </div>
          <button
            type="button"
            onClick={handleSave}
            disabled={!dirty || bodyMarkdownTooLong || saving || loading}
            className="btn-brutal bg-brutal-pink px-3 py-1.5 text-xs disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? formatMessage({ id: "settings.common.saving" }) : saved ? formatMessage({ id: "settings.common.saved" }) : formatMessage({ id: "settings.common.save" })}
          </button>
        </div>
      </div>
    </div>
  );
}

function ServerTabContent() {
  return (
    <>
      <ProfileSection />
      <PublicVisibilitySection />
      <ArchivedChannelsSection />
      <DangerZoneSection />
    </>
  );
}

function LabsTabContent() {
  const labsUiEnabled = useServerFeatureFlag(SERVER_LABS_UI_FEATURE_FLAG_KEY).enabled;
  return labsUiEnabled ? <LabsSection /> : null;
}

function BillingTabContent() {
  const { formatMessage } = useIntl();
  const server = useServerStore((s) => s.current);
  const loadingServers = useServerStore((s) => s.loading);
  const { capabilities } = useServerPermissions();

  if (!server && loadingServers) {
    return <PlanBillingLoadingSection />;
  }

  if (!capabilities.viewBilling) {
    return (
      <div className="mb-6">
        <SectionHeader
          className="mb-3"
          icon={<CreditCard size={16} />}
          label={formatMessage({ id: "billing.billing" })}
        />
        <div className="border-2 border-black bg-white p-4 text-sm text-black/60 shadow-brutal-sm">
          {formatMessage({ id: "billing.onlyServerOwnersAndAdminsCanViewBilling" })}
        </div>
      </div>
    );
  }
  return (
    <>
      <PlanSection />
    </>
  );
}

function AdministrationTabContent() {
  const { capabilities } = useServerPermissions();
  return (
    <>
      {capabilities.changeMemberRoles && <AdminsSection />}
      {capabilities.changeChannelVisibility && <SystemChannelsSection />}
      <InvitesSection />
      <JoinLinksSection />
      {capabilities.editServerSettings && <PreJoinAgreementSection />}
      <OnboardingAgentSection />
      <ServerTranslationSection />
      <MemberPermissionsSection />
    </>
  );
}

// Visual-testing render targets: components.settings.admins.* cases
// capture ONE section each instead of the shared tab top — without this every
// administration case screenshotted the identical first viewport of the tab
// (Slock task #333). Keys follow the case-id suffix.
export const ADMINISTRATION_VISUAL_SECTIONS = {
  admins: AdminsSection,
  // Insertion order mirrors AdministrationTabContent — the full-height case
  // stacks Object.values of this map, so system-channels must sit right after
  // admins to match the real route (and Android's canonical order, task #388).
  "system-channels": SystemChannelsSection,
  invites: InvitesSection,
  "join-links": JoinLinksSection,
  "pre-join-agreement": PreJoinAgreementSection,
  onboarding: OnboardingAgentSection,
  translation: ServerTranslationSection,
  "member-permissions": MemberPermissionsSection,
} as const;

function AppearanceSection() {
  const { formatMessage } = useIntl();
  const messageBodyFontSize = useAppearanceStore((s) => s.messageBodyFontSize);
  const setMessageBodyFontSize = useAppearanceStore((s) => s.setMessageBodyFontSize);
  const showLiveAgentActivityBar = useAppearanceStore((s) => s.showLiveAgentActivityBar);
  const setShowLiveAgentActivityBar = useAppearanceStore((s) => s.setShowLiveAgentActivityBar);
  const showAgentModelName = useAppearanceStore((s) => s.showAgentModelName);
  const setShowAgentModelName = useAppearanceStore((s) => s.setShowAgentModelName);
  const previewMessage = useMemo<Message>(() => ({
    id: "appearance-preview-message",
    channelId: APPEARANCE_PREVIEW_CHANNEL.id,
    senderType: "agent",
    senderId: APPEARANCE_PREVIEW_AGENT.id,
    senderName: APPEARANCE_PREVIEW_AGENT.displayName ?? APPEARANCE_PREVIEW_AGENT.name,
    messageType: "chat",
    content: formatMessage({ id: "settings.appearance.fontPreviewSample" }),
    createdAt: new Date().toISOString(),
    attachments: [],
    reactions: [],
  }), [formatMessage]);

  return (
    <div className="mb-6">
      <div className="flex items-center gap-2 mb-3">
        <Type size={16} className="text-black/60" />
        <span className="text-xs font-bold uppercase text-black/60 tracking-widest">
          {formatMessage({ id: "settings.appearance.sectionLabel" })}
        </span>
      </div>

      <div className="border-2 border-black bg-white shadow-brutal-sm p-4 space-y-4">
        <div>
          <div className="text-sm font-bold text-black">{formatMessage({ id: "settings.appearance.messageFontSizeTitle" })}</div>
          <p className="mt-1 text-xs text-black/55">
            {formatMessage({ id: "settings.appearance.messageFontSizeDescription" })}
          </p>
        </div>

        <MessageBodyFontSizeSegmentedControl
          value={messageBodyFontSize}
          onValueChange={setMessageBodyFontSize}
        />

        <div className="text-[11px] font-bold text-black/45">
          {formatMessage({ id: "settings.appearance.savedOnDevice" })}
        </div>

        <div className="space-y-2">
          <div className="text-[10px] font-bold uppercase tracking-widest text-black/50">
            {formatMessage({ id: "settings.appearance.preview" })}
          </div>
          <div className="pointer-events-none -mx-2" aria-label={formatMessage({ id: "settings.appearance.fontSizePreviewAria" })}>
            <MessageItem
              message={previewMessage}
              mentionMap={APPEARANCE_PREVIEW_MENTION_MAP}
              channels={[APPEARANCE_PREVIEW_CHANNEL]}
              previewSenderAgent={APPEARANCE_PREVIEW_AGENT}
              hideThreadActions
            />
          </div>
        </div>
      </div>

      <div className="mt-4 border-2 border-black bg-white p-4 shadow-brutal-sm">
        <div className="flex items-start justify-between gap-4">
          <span className="min-w-0">
            <span id="live-agent-activity-setting-label" className="block text-sm font-bold text-black">
              {formatMessage({ id: "settings.appearance.liveAgentActivityTitle" })}
            </span>
            <span id="live-agent-activity-setting-description" className="mt-0.5 block text-xs leading-5 text-black/60">
              {formatMessage({ id: "settings.appearance.liveAgentActivityDescription" })}
            </span>
            <span className="mt-2 block text-[11px] font-bold text-black/45">
              {formatMessage({ id: "settings.appearance.savedOnDevice" })}
            </span>
          </span>
          <Switch
            size="md"
            checked={showLiveAgentActivityBar}
            onCheckedChange={setShowLiveAgentActivityBar}
            aria-labelledby="live-agent-activity-setting-label"
            aria-describedby="live-agent-activity-setting-description"
            className="mt-0.5 shrink-0"
          />
        </div>
      </div>

      <div className="mt-4 border-2 border-black bg-white p-4 shadow-brutal-sm">
        <div className="flex items-start justify-between gap-4">
          <span className="min-w-0">
            <span id="agent-model-name-setting-label" className="block text-sm font-bold text-black">
              {formatMessage({ id: "settings.appearance.showAgentModelNameTitle" })}
            </span>
            <span id="agent-model-name-setting-description" className="mt-0.5 block text-xs leading-5 text-black/60">
              {formatMessage({ id: "settings.appearance.showAgentModelNameDescription" })}
            </span>
            <span className="mt-2 block text-[11px] font-bold text-black/45">
              {formatMessage({ id: "settings.appearance.savedOnDevice" })}
            </span>
          </span>
          <Switch
            size="md"
            checked={showAgentModelName}
            onCheckedChange={setShowAgentModelName}
            aria-labelledby="agent-model-name-setting-label"
            aria-describedby="agent-model-name-setting-description"
            className="mt-0.5 shrink-0"
          />
        </div>
      </div>

    </div>
  );
}

// Exported for settingsSubBatchC.i18n.behavior.test.tsx — rendered directly so the
// zh teeth exercise the real component without mounting the full SettingsPanel
// (whose account tab reads the Vite-only `import.meta.env` graph). Same precedent
// as the exported `AccountSection` used by sub-batch A.
export function AboutSection({ appVersion = WEB_APP_VERSION }: { appVersion?: string } = {}) {
  const { formatMessage } = useIntl();
  const currentServer = useServerStore((s) => s.current);
  // Absolute, because the phone scanning this is not on our origin — a relative
  // path encodes to something the camera app cannot open.
  //
  // Built from the WEB origin, not the API base. The download buttons below do
  // use the API base (the API is on a different host in every deployed
  // environment), so the two are deliberately different and neither should be
  // "made consistent" with the other:
  //
  // App Links / Universal Links are only ever triggered for hosts that serve the
  // association files, and those live on the web origin — so a QR pointing at
  // the API origin can never open the app, however correct the native side is
  // (@Mahua). The chooser at /download is public and does the platform split,
  // so nothing is lost for someone who does not have the app.
  const mobileDownloadQrUrl = `${typeof window === "undefined" ? "" : window.location.origin}${MOBILE_DOWNLOAD_CHOOSER_PATH}`;

  return (
    <div className="space-y-4">
      <section className="space-y-2">
        <SectionHeader label={formatMessage({ id: "settings.about.versionSectionLabel" })} icon={<Tag size={16} />} />
        <SurfaceListItem interactive={false} className="space-y-1">
          {/* Product wordmark — catalog brand id; locale values may match. */}
          <div className="text-sm font-bold text-black">{formatMessage({ id: "brand.productName" })}</div>
          <div className="text-xs text-black/60">{appVersion}</div>
        </SurfaceListItem>
      </section>

      {/*
        Mobile app is a companion surface, not an entry point: someone who
        installs it without a connected Computer still cannot use Raft, which is
        why this lives here rather than on the landing page (@wenyi). The Help
        menu carries only a signpost to it — this section is the single content
        host, so there is exactly one place to keep current.
      */}
      <section className="space-y-2">
        <SectionHeader label={formatMessage({ id: "settings.mobileApp.sectionLabel" })} icon={<Smartphone size={16} />} />
        <SurfaceListItem interactive={false}>
          <div className="min-w-0 space-y-3">
            <div className="text-xs text-black/60">{formatMessage({ id: "settings.mobileApp.description" })}</div>
            {/* Both buttons are peers, deliberately. A primary/secondary pair
                reads as a recommendation, and we have no basis for one: the
                person's phone is not the device rendering this, so we cannot
                know which applies to them. Styling Android as the CTA sent
                iPhone users looking for the "real" button (@wenyi). */}
            <div className="flex flex-wrap gap-2">
              <a
                className="btn-brutal-sm bg-white px-3 py-1.5 text-sm font-bold"
                href={mobileDownloadUrl("android")}
                data-testid="mobile-download-android"
              >
                {formatMessage({ id: "settings.mobileApp.android" })}
              </a>
              {/* New tab, because this one LEAVES Raft: our route 302s to
                  testflight.apple.com. Android deliberately does NOT get this —
                  it resolves to a file download, and a download in a fresh tab
                  strands an empty tab behind it. The asymmetry is the point
                  (@wenyi). */}
              <a
                className="btn-brutal-sm bg-white px-3 py-1.5 text-sm font-bold"
                href={mobileDownloadUrl("ios")}
                target="_blank"
                rel="noopener noreferrer"
                data-testid="mobile-download-ios"
              >
                {formatMessage({ id: "settings.mobileApp.ios" })}
              </a>
            </div>
            {/* Left-aligned with the rest of the card rather than pinned to the
                far edge: on a wide settings panel the right edge is a long way
                from the buttons, and the code read as an unrelated decoration
                floating in whitespace (@wenyi).

                No `platform` in the encoded URL on purpose — the scanning phone
                is not this device, so the route's UA fallback decides, and one
                code serves both platforms. */}
            <MobileDownloadQr url={mobileDownloadQrUrl} />
          </div>
        </SurfaceListItem>
      </section>

      <section className="space-y-2">
        <SectionHeader label={formatMessage({ id: "settings.about.workspaceSectionLabel" })} icon={<Building2 size={16} />} />
        <SurfaceListItem interactive={false} className="space-y-1">
          <div className="text-sm font-bold text-black">{currentServer?.name ?? formatMessage({ id: "settings.about.workspaceNameFallback" })}</div>
          <div className="text-xs text-black/60">{currentServer?.slug ? `/${currentServer.slug}` : formatMessage({ id: "settings.about.workspaceDetailsFallback" })}</div>
        </SurfaceListItem>
      </section>
    </div>
  );
}

function McpSettingsSection() {
  const { capabilities } = useServerPermissions();
  return (
    <AgentMcpTab
      scope="server"
      canManageServer={capabilities.manageIntegrations}
    />
  );
}

// NOT exported for tests: this card is gated by useWorkspaceGridAvailability(),
// which reads `import.meta.env.DEV` — undefined in the node test harness, so it
// throws before rendering. Its `settings.workspaceMode.*` ids therefore have only
// catalog-parity coverage in settingsSubBatchC.i18n.behavior.test.tsx, not a
// render tooth; see the GAP note there.
function WorkspaceModeSettingsCard() {
  const { formatMessage } = useIntl();
  const availability = useWorkspaceGridAvailability();
  const userId = useAuthStore((s) => s.user?.id ?? null);
  const enabled = useWorkspaceGridNavigationStore((s) => s.enabled);
  const setEnabled = useWorkspaceGridNavigationStore((s) => s.setEnabled);
  if (!availability.resolved || !availability.enabled) return null;

  return (
    <label className="mb-4 flex items-center justify-between gap-4 border-2 border-black bg-brutal-cream p-4 shadow-brutal-sm">
      <span className="min-w-0">
        <span className="block text-sm font-bold">{formatMessage({ id: "settings.workspaceMode.title" })}</span>
        <span className="mt-1 block text-xs leading-5 text-black/60">{formatMessage({ id: "settings.workspaceMode.description" })}</span>
      </span>
      <input
        type="checkbox"
        checked={enabled}
        onChange={(event) => setEnabled(event.currentTarget.checked, userId)}
        className="size-5 shrink-0 accent-black"
      />
    </label>
  );
}

export default function SettingsPanel({
  tab: tabProp,
  accountInitialError,
  accountPasswordChangeIntent = false,
}: {
  tab?: string;
  accountInitialError?: string;
  accountPasswordChangeIntent?: boolean;
}) {
  const { formatMessage } = useIntl();
  const requestedSettingsTab = normalizeSettingsTab(tabProp);
  const providerConnectionsEnabled = useServerFeatureFlag(PROVIDER_CONNECTIONS_FEATURE_FLAG_KEY).enabled;
  const slackBridgeGate = useServerFeatureFlag(SLACK_BRIDGE_FEATURE_FLAG_KEYS.master);
  const slackBridgeEnabled = isSlackBridgeSurfaceEnabled(slackBridgeGate);
  const wikiEnabled = useServerFeatureFlag(WIKI_FEATURE_FLAG_KEY).enabled;
  const { capabilities, role } = useServerPermissions();
  const settingsTab = (
    (requestedSettingsTab === "providers" && (!providerConnectionsEnabled || !capabilities.manageExternalAuth))
    || (requestedSettingsTab === "im-bridges" && !slackBridgeEnabled)
  )
    ? "account"
    : requestedSettingsTab === "wiki" && (!wikiEnabled || !capabilities.editServerSettings)
    ? "account"
    : !canOpenSettingsTab(requestedSettingsTab, capabilities, role)
    ? "account"
    : requestedSettingsTab;
  // Every tab title maps through the catalog — and now the type says so, so the
  // claim cannot go stale again. It had: `about` was absent, and this fallback
  // silently rendered the English `label`.
  const activeLabel = formatMessage({ id: SETTINGS_TAB_TITLE_ID[settingsTab] });
  const ActiveIcon = SETTINGS_ICON_BY_ID[settingsTab] ?? Settings;
  const serverSlug = useServerStore((s) => s.current?.slug);
  // Mobile back: Settings sub-pages (account / browser / server) are
  // level-2 views inside the Settings tab. Per iOS NavigationView model
  // (@stdrc 2026-04-30 #proj-uiux:c8711d2a), every level-2+ view must
  // cover the tab bar and show a top-left back button — so we pop back
  // to the Settings tab home here.
  const onMobileBack = useMobileBack(serverSlug ? `/s/${serverSlug}/settings` : "/");
  // embed=1: the mobile app renders this tab inside an in-app WebView with its
  // own native header (Administration/Billing pattern, botiverse/mobile#868).
  // Drop the panel header so the page isn't double-chromed; content only.
  const embedded = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("embed") === "1";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {!embedded && settingsTab !== "feedback" && (
        <PanelHeader
          title={activeLabel}
          icon={<ActiveIcon size={18} />}
          iconBg="bg-soft-signal text-black"
          containerProps={{
            "data-testid": "settings-panel-header",
            "data-slock-settings-tab": settingsTab,
          }}
          onMobileBack={onMobileBack}
          mobileBackProps={{ "data-testid": "settings-mobile-back", title: formatMessage({ id: "settings.tabs.back" }) }}
        />
      )}

      {/* Content */}
      <div className={settingsTab === "feedback"
        ? "min-h-0 flex-1 bg-white"
        : "flex-1 overflow-y-auto bg-white px-5 py-4"}
      >
        {settingsTab === "account" && <WorkspaceModeSettingsCard />}
        {settingsTab === "account" && (
          <AccountSection
            initialError={accountInitialError}
            passwordChangeIntent={accountPasswordChangeIntent}
          />
        )}
        {settingsTab === "language-region" && <LanguageRegionSection />}
        {settingsTab === "appearance" && <AppearanceSection />}
        {settingsTab === "notifications" && <NotificationsTabContent />}
        {settingsTab === "server" && <ServerTabContent />}
        {settingsTab === "wiki" && <WikiSettingsSection />}
        {settingsTab === "mcp" && <McpSettingsSection />}
        {settingsTab === "providers" && <ProviderConnectionsSettings />}
        {settingsTab === "labs" && <LabsTabContent />}
        {settingsTab === "billing" && <BillingTabContent />}
        {settingsTab === "administration" && <AdministrationTabContent />}
        {settingsTab === "im-bridges" && <IMBridgesSettingsSection />}
        {settingsTab === "integrations" && <IntegrationsSection />}
        {settingsTab === "about" && <AboutSection />}
        {settingsTab === "feedback" && <LazyAboutFeedbackPanel />}
      </div>
    </div>
  );
}
