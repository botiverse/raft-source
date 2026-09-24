import { useEffect, useMemo, useReducer, useState } from "react";
import { AlertTriangle, Check, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useIntl } from "react-intl";
import { SLACK_BRIDGE_PREFLIGHT_CHECK_IDS } from "@botiverse/raft-shared";
import {
  Select,
  SelectContent,
  SelectIcon,
  SelectItem,
  SelectItemIndicator,
  SelectItemText,
  SelectList,
  SelectTrigger,
  SelectValue,
} from "raft-ui";
import type { MessageId } from "../../i18n/messages";
import Banner from "../ui/Banner";
import Button from "../ui/Button";
import FormField from "../ui/FormField";
import SectionEyebrow from "../ui/SectionEyebrow";
import {
  applyManagedSlackBridgeChannelPairs,
  finishSlackBridgeSetup,
  isSlackBridgePreflightPassed,
  projectSlackBridgeHealth,
  SlackBridgePartialUpdateError,
  validateSlackBridgeChannelPairs,
  verifyAndEnableSlackBridge,
} from "./slackBridgeProvisioning";
import type {
  SlackBridgeChannelPair,
  SlackBridgeHealthAction,
  SlackBridgeHealthReason,
  SlackBridgeHealthState,
  SlackBridgePreflightCheckId,
  SlackBridgeProvisioningProvider,
  SlackBridgeProvisioningView,
  SlackBridgeSetupSnapshot,
  SlackBridgeSetupStage,
} from "./slackBridgeProvisioning";

type SlackBridgeDisplayStage = "connect" | "channels" | "health";

const DISPLAY_STAGES: SlackBridgeDisplayStage[] = ["connect", "channels", "health"];

const STAGE_LABEL_ID: Record<SlackBridgeSetupStage, MessageId> = {
  connect: "settings.slackBridge.stage.connect",
  oauth: "settings.slackBridge.stage.oauth",
  channels: "settings.slackBridge.stage.channels",
  preflight: "settings.slackBridge.stage.preflight",
  enable: "settings.slackBridge.stage.enable",
  health: "settings.slackBridge.stage.health",
};

const HEALTH_LABEL_ID: Record<SlackBridgeHealthState, MessageId> = {
  connected: "settings.slackBridge.health.connected",
  degraded: "settings.slackBridge.health.degraded",
  unverified: "settings.slackBridge.health.unverified",
  disconnected: "settings.slackBridge.health.disconnected",
};

const HEALTH_REASON_ID: Record<SlackBridgeHealthReason, MessageId> = {
  healthy: "settings.slackBridge.reason.healthy",
  install_missing: "settings.slackBridge.reason.installMissing",
  oauth_pending: "settings.slackBridge.reason.oauthPending",
  reauth_required: "settings.slackBridge.reason.reauthRequired",
  install_disconnected: "settings.slackBridge.reason.installDisconnected",
  install_revoked: "settings.slackBridge.reason.installRevoked",
  install_quarantined: "settings.slackBridge.reason.installQuarantined",
  credential_missing: "settings.slackBridge.reason.credentialMissing",
  credential_persist_unknown: "settings.slackBridge.reason.credentialPersistUnknown",
  credential_revoked: "settings.slackBridge.reason.credentialRevoked",
  binding_required: "settings.slackBridge.reason.bindingRequired",
  binding_paused: "settings.slackBridge.reason.bindingPaused",
  binding_revoked: "settings.slackBridge.reason.bindingRevoked",
  binding_quarantined: "settings.slackBridge.reason.bindingQuarantined",
  audience_mismatch: "settings.slackBridge.reason.audienceMismatch",
  audience_unavailable: "settings.slackBridge.reason.audienceUnavailable",
  connection_failed: "settings.slackBridge.reason.connectionFailed",
  scope_mismatch: "settings.slackBridge.reason.scopeMismatch",
  verification_required: "settings.slackBridge.reason.verificationRequired",
};

const HEALTH_ACTION_ID: Record<SlackBridgeHealthAction, MessageId> = {
  none: "settings.slackBridge.action.none",
  connect: "settings.slackBridge.action.connect",
  finish_oauth: "settings.slackBridge.action.finishOauth",
  reauthorize: "settings.slackBridge.action.reauthorize",
  reconnect: "settings.slackBridge.action.reconnect",
  resolve_quarantine: "settings.slackBridge.action.resolveQuarantine",
  verify_credential: "settings.slackBridge.action.verifyCredential",
  configure_binding: "settings.slackBridge.action.configureBinding",
  resume_binding: "settings.slackBridge.action.resumeBinding",
  repair_binding: "settings.slackBridge.action.repairBinding",
  repair_audience: "settings.slackBridge.action.repairAudience",
  retry_verification: "settings.slackBridge.action.retryVerification",
};

const PREFLIGHT_LABEL_ID: Record<SlackBridgePreflightCheckId, MessageId> = {
  oauth: "settings.slackBridge.preflight.oauth",
  endpoint: "settings.slackBridge.preflight.endpoint",
  scope: "settings.slackBridge.preflight.scope",
  audience: "settings.slackBridge.preflight.audience",
};

const PREFLIGHT_STATE_ID: Record<"passed" | "failed" | "unverified", MessageId> = {
  passed: "settings.slackBridge.check.passed",
  failed: "settings.slackBridge.check.failed",
  unverified: "settings.slackBridge.check.unverified",
};

const FAILING_SURFACE_ID: Record<Exclude<SlackBridgeSetupSnapshot["rawHealth"]["failingSurface"], null>, MessageId> = {
  install: "settings.slackBridge.surface.install",
  credential: "settings.slackBridge.surface.credential",
  binding: "settings.slackBridge.surface.binding",
  audience: "settings.slackBridge.surface.audience",
  connection: "settings.slackBridge.surface.connection",
  scope: "settings.slackBridge.surface.scope",
};

function displayStage(stage: SlackBridgeSetupStage): SlackBridgeDisplayStage {
  if (stage === "connect" || stage === "oauth") return "connect";
  if (stage === "health") return "health";
  return "channels";
}

function StepRail({ stage }: { stage: SlackBridgeSetupStage }) {
  const { formatMessage } = useIntl();
  const current = displayStage(stage);
  const activeIndex = DISPLAY_STAGES.indexOf(current);
  return (
    <ol className="grid grid-cols-3 gap-1.5" aria-label={formatMessage({ id: "settings.slackBridge.progress" })}>
      {DISPLAY_STAGES.map((item, index) => (
        <li
          key={item}
          className={`border border-black px-2 py-1 text-center text-[10px] font-bold uppercase tracking-wide ${
            index < activeIndex ? "bg-brutal-lime/40" : index === activeIndex ? "bg-brutal-pink" : "bg-white text-black/45"
          }`}
          aria-current={item === current ? "step" : undefined}
        >
          {formatMessage({ id: STAGE_LABEL_ID[item] })}
        </li>
      ))}
    </ol>
  );
}

function PreflightResults({
  preflight,
  passed,
}: {
  preflight: NonNullable<SlackBridgeSetupSnapshot["preflight"]>;
  passed: boolean;
}) {
  const { formatMessage } = useIntl();
  const checks = new Map(preflight.checks.map((check) => [check.id, check.state]));
  return (
    <div className="mt-3 space-y-3">
      {passed ? (
        <Banner intent="success" density="sm" icon={<Check size={16} />}>
          {formatMessage({ id: "settings.slackBridge.preflightPassed" })}
        </Banner>
      ) : (
        <Banner intent="warning" density="sm" icon={<AlertTriangle size={16} />}>
          {formatMessage({ id: "settings.slackBridge.preflightNotPassed" })}
        </Banner>
      )}
      <ul className="grid gap-2 sm:grid-cols-2">
        {SLACK_BRIDGE_PREFLIGHT_CHECK_IDS.map((checkId) => {
          const state = checks.get(checkId) ?? "unverified";
          return (
            <li key={checkId} className="flex items-center justify-between border border-black bg-brutal-cream px-3 py-2 text-xs">
              <span className="font-bold">{formatMessage({ id: PREFLIGHT_LABEL_ID[checkId] })}</span>
              <span className="uppercase">{formatMessage({ id: PREFLIGHT_STATE_ID[state] })}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function HealthPanel({
  snapshot,
  channelNames,
  canManage,
  onManage,
  busy,
  onRefresh,
}: {
  snapshot: SlackBridgeSetupSnapshot;
  channelNames: { raft: Map<string, string>; slack: Map<string, string> };
  canManage: boolean;
  onManage: () => void;
  busy: boolean;
  onRefresh: () => void;
}) {
  const { formatDate, formatMessage } = useIntl();
  const [showInviteHelp, setShowInviteHelp] = useState(false);
  const health = projectSlackBridgeHealth(snapshot.rawHealth);
  const mappedChannelsWithAccessIssues = snapshot.channelPairs
    .map((pair) => snapshot.slackChannels.find((channel) => channel.id === pair.slackChannelId))
    .filter((channel): channel is NonNullable<typeof channel> => channel?.isMember !== true);
  const channelsMissingMembership = mappedChannelsWithAccessIssues
    .filter((channel) => channel.isMember === false);
  const hasUnknownMembership = mappedChannelsWithAccessIssues
    .some((channel) => channel.isMember === undefined);
  const showMembershipRecovery = health.reason === "audience_mismatch"
    && mappedChannelsWithAccessIssues.length > 0;
  const tone = health.state === "connected"
    ? "bg-brutal-lime/30"
    : health.state === "degraded"
      ? "bg-brutal-orange/25"
      : health.state === "unverified"
        ? "bg-soft-signal/30"
        : "bg-brutal-red/20";

  return (
    <div className={`border-2 border-black p-4 shadow-brutal-sm ${tone}`} data-testid="slack-bridge-health">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <SectionEyebrow as="div">{formatMessage({ id: "settings.slackBridge.healthLabel" })}</SectionEyebrow>
          <div className="mt-1 text-xl font-black">{formatMessage({ id: HEALTH_LABEL_ID[health.state] })}</div>
          <div className="mt-1 text-xs leading-relaxed text-black/70">
            {formatMessage({ id: HEALTH_REASON_ID[health.reason] })}
          </div>
        </div>
        {snapshot.workspaceName && (
          <div className="border border-black bg-white px-2 py-1 text-xs font-bold">{snapshot.workspaceName}</div>
        )}
      </div>
      {showMembershipRecovery && (
        <Banner
          className="mt-4"
          intent="warning"
          density="sm"
          withIcon
          title={formatMessage({
            id: hasUnknownMembership
              ? "settings.slackBridge.membershipRecoveryUnknownTitle"
              : "settings.slackBridge.membershipRecoveryTitle",
          })}
        >
          <p>{hasUnknownMembership
            ? formatMessage({ id: "settings.slackBridge.membershipRecoveryUnknownDescription" })
            : formatMessage(
              { id: "settings.slackBridge.membershipRecoveryDescription" },
              {
                channels: channelsMissingMembership
                  .map((channel) => `#${channel.name}`)
                  .join(", "),
              },
            )}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" onClick={() => setShowInviteHelp((visible) => !visible)}>
              {formatMessage({ id: "settings.slackBridge.showInviteSteps" })}
            </Button>
            <Button size="sm" shape="iconText" tone="pink" disabled={busy} onClick={onRefresh}>
              <RefreshCw size={13} />
              {formatMessage({ id: "settings.slackBridge.refreshAndRecheck" })}
            </Button>
          </div>
          {showInviteHelp && (
            <ol className="mt-3 list-decimal space-y-1 pl-5 font-semibold">
              <li>{formatMessage({ id: "settings.slackBridge.inviteStepOpen" })}</li>
              <li>{formatMessage({ id: "settings.slackBridge.inviteStepInvite" })}</li>
              <li>{formatMessage({ id: "settings.slackBridge.inviteStepReturn" })}</li>
            </ol>
          )}
        </Banner>
      )}
      <dl className="mt-4 grid gap-3 text-xs sm:grid-cols-3">
        <div>
          <dt className="font-bold text-black/55">{formatMessage({ id: "settings.slackBridge.lastVerifiedLabel" })}</dt>
          <dd className="mt-0.5 font-semibold">
            {health.lastVerifiedAt
              ? formatMessage(
                { id: "settings.slackBridge.lastVerified" },
                {
                  when: formatDate(health.lastVerifiedAt, {
                    dateStyle: "medium",
                    timeStyle: "short",
                    timeZone: "UTC",
                  }),
                },
              )
              : formatMessage({ id: "settings.slackBridge.notVerified" })}
          </dd>
        </div>
        <div>
          <dt className="font-bold text-black/55">{formatMessage({ id: "settings.slackBridge.failingSurfaceLabel" })}</dt>
          <dd className="mt-0.5 font-semibold">
            {health.failingSurface
              ? formatMessage({ id: FAILING_SURFACE_ID[health.failingSurface] })
              : formatMessage({ id: "settings.slackBridge.failingSurfaceNone" })}
          </dd>
        </div>
        <div>
          <dt className="font-bold text-black/55">{formatMessage({ id: "settings.slackBridge.nextActionLabel" })}</dt>
          <dd className="mt-0.5 font-semibold">{formatMessage({ id: HEALTH_ACTION_ID[health.action] })}</dd>
        </div>
      </dl>
      <div className="mt-4 border-t border-black/30 pt-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-xs font-bold uppercase tracking-wide text-black/60">
            {formatMessage({ id: "settings.slackBridge.selectedPairs" })}
          </div>
          {canManage && (
            <Button size="sm" onClick={onManage}>
              {formatMessage({ id: "settings.slackBridge.managePairs" })}
            </Button>
          )}
        </div>
        <ul className="mt-2 space-y-1.5">
          {snapshot.channelPairs.map((pair) => (
            <li key={`${pair.raftChannelId}:${pair.slackChannelId}`} className="border border-black bg-white px-3 py-2 text-xs font-bold">
              {formatMessage(
                { id: "settings.slackBridge.channelPair" },
                {
                  raftName: channelNames.raft.get(pair.raftChannelId),
                  slackName: channelNames.slack.get(pair.slackChannelId),
                },
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

interface SlackBridgeSetupWizardProps {
  canManage: boolean;
  provider: SlackBridgeProvisioningProvider;
  onOAuthRedirect?: (url: string) => void;
}

interface WizardState {
  view: SlackBridgeProvisioningView | null;
  busy: boolean;
  error: boolean;
  partialSuccess: boolean;
  pairs: SlackBridgeChannelPair[];
  raftChannelId: string;
  slackChannelId: string;
  disconnectConfirmed: boolean;
  editingMappings: boolean;
  mappingBaseline: SlackBridgeSetupSnapshot | null;
}

type WizardAction =
  | { type: "start" }
  | { type: "view"; view: SlackBridgeProvisioningView }
  | { type: "error"; partialSuccess?: boolean }
  | { type: "pairs"; pairs: SlackBridgeChannelPair[] }
  | { type: "raft_channel"; channelId: string }
  | { type: "slack_channel"; channelId: string }
  | { type: "confirm_disconnect" }
  | { type: "cancel_disconnect" }
  | { type: "edit_mappings" }
  | { type: "refresh_view"; view: SlackBridgeProvisioningView };

const INITIAL_WIZARD_STATE: WizardState = {
  view: null,
  busy: false,
  error: false,
  partialSuccess: false,
  pairs: [],
  raftChannelId: "",
  slackChannelId: "",
  disconnectConfirmed: false,
  editingMappings: false,
  mappingBaseline: null,
};

function wizardReducer(state: WizardState, action: WizardAction): WizardState {
  switch (action.type) {
    case "start":
      return { ...state, busy: true, error: false, partialSuccess: false };
    case "view": {
      const snapshot = action.view.kind === "ready" ? action.view.snapshot : null;
      if (snapshot?.stage === "channels") {
        return {
          ...state,
          view: action.view,
          busy: false,
          error: false,
          partialSuccess: false,
          pairs: snapshot.channelPairs,
          raftChannelId: snapshot.raftChannels[0]?.id ?? "",
          slackChannelId: snapshot.slackChannels.find((channel) => channel.isMember === true)?.id ?? "",
          disconnectConfirmed: false,
          editingMappings: false,
          mappingBaseline: null,
        };
      }
      return {
        ...state,
        view: action.view,
        busy: false,
        error: false,
        partialSuccess: false,
        disconnectConfirmed: false,
        pairs: snapshot?.channelPairs ?? state.pairs,
        editingMappings: false,
        mappingBaseline: null,
      };
    }
    case "error":
      return { ...state, busy: false, error: true, partialSuccess: action.partialSuccess ?? false };
    case "pairs":
      return { ...state, pairs: action.pairs };
    case "raft_channel":
      return { ...state, raftChannelId: action.channelId };
    case "slack_channel":
      return { ...state, slackChannelId: action.channelId };
    case "confirm_disconnect":
      return { ...state, disconnectConfirmed: true };
    case "cancel_disconnect":
      return { ...state, disconnectConfirmed: false };
    case "edit_mappings":
      return {
        ...state,
        editingMappings: true,
        pairs: state.view?.kind === "ready" ? state.view.snapshot.channelPairs : state.pairs,
        slackChannelId: state.view?.kind === "ready"
          ? state.view.snapshot.slackChannels.find((channel) => channel.isMember === true)?.id ?? ""
          : state.slackChannelId,
        mappingBaseline: state.view?.kind === "ready" ? state.view.snapshot : null,
      };
    case "refresh_view": {
      const snapshot = action.view.snapshot;
      if (state.editingMappings && snapshot.stage === "health") {
        const raftChannelId = snapshot.raftChannels.some((channel) => channel.id === state.raftChannelId)
          ? state.raftChannelId
          : snapshot.raftChannels[0]?.id ?? "";
        const slackChannelId = snapshot.slackChannels.some((channel) =>
          channel.id === state.slackChannelId && channel.isMember === true)
          ? state.slackChannelId
          : snapshot.slackChannels.find((channel) => channel.isMember === true)?.id ?? "";
        return {
          ...state,
          view: action.view,
          busy: false,
          error: false,
          partialSuccess: false,
          raftChannelId,
          slackChannelId,
          mappingBaseline: snapshot,
        };
      }
      return wizardReducer(state, { type: "view", view: action.view });
    }
  }
}

export default function SlackBridgeSetupWizard({
  canManage,
  provider,
  onOAuthRedirect = (url) => window.location.assign(url),
}: SlackBridgeSetupWizardProps) {
  const { formatMessage } = useIntl();
  const [state, dispatch] = useReducer(wizardReducer, INITIAL_WIZARD_STATE);
  const {
    view,
    busy,
    error,
    partialSuccess,
    pairs,
    raftChannelId,
    slackChannelId,
    disconnectConfirmed,
    editingMappings,
    mappingBaseline,
  } = state;

  useEffect(() => {
    let active = true;
    dispatch({ type: "start" });
    void provider.load()
      .then((next) => {
        if (active) dispatch({ type: "view", view: next });
      })
      .catch(() => {
        if (active) dispatch({ type: "error" });
      });
    return () => {
      active = false;
    };
  }, [provider]);

  const snapshot = view?.kind === "ready" ? view.snapshot : null;

  const channelNames = useMemo(() => {
    const raft = new Map(snapshot?.raftChannels.map((channel) => [channel.id, channel.name]) ?? []);
    const slack = new Map(snapshot?.slackChannels.map((channel) => [channel.id, channel.name]) ?? []);
    return { raft, slack };
  }, [snapshot]);

  const mutate = async (operation: () => Promise<SlackBridgeProvisioningView>) => {
    dispatch({ type: "start" });
    try {
      dispatch({ type: "view", view: await operation() });
    } catch (cause) {
      dispatch({ type: "error", partialSuccess: cause instanceof SlackBridgePartialUpdateError });
    }
  };

  const refresh = async () => {
    dispatch({ type: "start" });
    try {
      dispatch({ type: "refresh_view", view: await provider.load() });
    } catch {
      dispatch({ type: "error" });
    }
  };

  const connectAndAuthorize = async () => {
    dispatch({ type: "start" });
    try {
      const connected = await provider.connect();
      if (connected.snapshot.stage !== "oauth") {
        dispatch({ type: "view", view: connected });
        return;
      }
      const result = await provider.beginOAuth();
      if (result.kind === "redirect") onOAuthRedirect(result.url);
      else dispatch({ type: "view", view: result.view });
    } catch {
      dispatch({ type: "error" });
    }
  };

  const addPair = () => {
    if (snapshot?.slackChannels.find((channel) => channel.id === slackChannelId)?.isMember !== true) return;
    const candidate = [...pairs, { raftChannelId, slackChannelId }];
    if (!validateSlackBridgeChannelPairs(candidate).valid) return;
    dispatch({ type: "pairs", pairs: candidate });
  };

  const pairValidation = validateSlackBridgeChannelPairs(pairs);
  const pairsUseMemberChannels = pairs.every((pair) =>
    snapshot?.slackChannels.find((channel) => channel.id === pair.slackChannelId)?.isMember === true);
  const pairChangesValid = editingMappings && pairs.length === 0
    ? true
    : pairValidation.valid && pairsUseMemberChannels;
  const raftChannelOptions = (snapshot?.raftChannels ?? []).map((channel) => ({
    value: channel.id,
    label: formatMessage({ id: "settings.slackBridge.channelName" }, { name: channel.name }),
  }));
  const slackChannelOptions = (snapshot?.slackChannels ?? []).map((channel) => ({
    value: channel.id,
    label: formatMessage(
      { id: channel.isMember === true
        ? "settings.slackBridge.channelName"
        : "settings.slackBridge.channelMembershipRequiredOption" },
      { name: channel.name },
    ),
    disabled: channel.isMember !== true,
  }));
  const availableSlackChannelCount = snapshot?.slackChannels
    .filter((channel) => channel.isMember === true).length ?? 0;
  const inviteRequiredSlackChannelCount = snapshot?.slackChannels
    .filter((channel) => channel.isMember !== true).length ?? 0;
  const selectedSlackChannelIsMember = snapshot?.slackChannels
    .find((channel) => channel.id === slackChannelId)?.isMember === true;
  const preflightPassed = isSlackBridgePreflightPassed(snapshot?.preflight ?? null);
  const disconnectConnectionEpoch = Number(snapshot?.rawHealth?.install?.epochs.connection ?? NaN);
  const canDisconnect = canManage
    && !!provider.disconnect
    && snapshot?.stage !== "connect"
    && snapshot?.rawHealth?.install?.state !== "revoked"
    && Number.isSafeInteger(disconnectConnectionEpoch)
    && disconnectConnectionEpoch > 0;

  if (busy && !view) {
    return <div className="border-2 border-black bg-white p-4 text-xs font-bold">{formatMessage({ id: "settings.slackBridge.loading" })}</div>;
  }

  if (!view && error) {
    return (
      <Banner intent="warning" density="lg" withIcon title={formatMessage({ id: "settings.slackBridge.title" })}>
        {formatMessage({ id: "settings.slackBridge.operationFailed" })}
      </Banner>
    );
  }

  if (!snapshot) return null;

  return (
    <section className="space-y-3 border-2 border-black bg-brutal-cream p-4 shadow-brutal-sm" data-testid="slack-bridge-setup-wizard">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <SectionEyebrow as="div">{formatMessage({ id: "settings.slackBridge.eyebrow" })}</SectionEyebrow>
          <h3 className="mt-1 text-lg font-black">{formatMessage({ id: "settings.slackBridge.title" })}</h3>
          <p className="mt-1 max-w-2xl text-xs leading-relaxed text-black/60">
            {formatMessage({ id: "settings.slackBridge.description" })}
          </p>
        </div>
        {!canManage && (
          <div className="border border-black bg-white px-2 py-1 text-xs font-bold">
            {formatMessage({ id: "settings.slackBridge.readOnly" })}
          </div>
        )}
      </div>
      <StepRail stage={snapshot.stage} />
      {error && (
        <Banner intent="warning" density="sm" withIcon>
          {formatMessage({
            id: partialSuccess
              ? "settings.slackBridge.mappingPartialFailure"
              : "settings.slackBridge.operationFailed",
          })}
        </Banner>
      )}

      {snapshot.stage === "connect" && (
        <div className="border-2 border-black bg-white p-4">
          <div className="text-sm font-bold">{formatMessage({ id: "settings.slackBridge.connectTitle" })}</div>
          <p className="mt-1 text-xs text-black/60">{formatMessage({ id: "settings.slackBridge.connectDescription" })}</p>
          {canManage && (
            <Button className="mt-3" tone="pink" size="md" disabled={busy} onClick={() => void connectAndAuthorize()}>
              {formatMessage({ id: "settings.slackBridge.connect" })}
            </Button>
          )}
        </div>
      )}

      {snapshot.stage === "oauth" && (
        <div className="border-2 border-black bg-white p-4">
          <div className="text-sm font-bold">{formatMessage({ id: "settings.slackBridge.oauthTitle" })}</div>
          <p className="mt-1 text-xs text-black/60">{formatMessage({ id: "settings.slackBridge.oauthDescription" })}</p>
          {canManage && (
            <Button
              className="mt-3"
              tone="pink"
              size="md"
              disabled={busy}
              onClick={() => {
                dispatch({ type: "start" });
                void provider.beginOAuth()
                  .then((result) => {
                    if (result.kind === "redirect") onOAuthRedirect(result.url);
                    else dispatch({ type: "view", view: result.view });
                  })
                  .catch(() => dispatch({ type: "error" }));
              }}
            >
              {formatMessage({ id: "settings.slackBridge.authorize" })}
            </Button>
          )}
        </div>
      )}

      {(snapshot.stage === "channels" || (snapshot.stage === "health" && editingMappings)) && (
        <div className="space-y-3 border-2 border-black bg-white p-4">
          <div>
            <div className="text-sm font-bold">{formatMessage({ id: "settings.slackBridge.channelsTitle" })}</div>
            <p className="mt-1 text-xs text-black/60">{formatMessage({ id: "settings.slackBridge.channelsDescription" })}</p>
          </div>
          <p className="text-xs font-bold text-black/65" aria-live="polite">
            {formatMessage(
              { id: "settings.slackBridge.channelAvailabilitySummary" },
              {
                availableCount: availableSlackChannelCount,
                inviteRequiredCount: inviteRequiredSlackChannelCount,
              },
            )}
          </p>
          {canManage && (
            <div
              className="grid gap-x-2 gap-y-1 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]"
              data-testid="slack-bridge-channel-pair-grid"
            >
              <FormField label={formatMessage({ id: "settings.slackBridge.raftChannel" })} size="compact" labelStyle="plain">
                <Select
                  value={raftChannelId}
                  onValueChange={(value) => {
                    if (value != null) dispatch({ type: "raft_channel", channelId: value });
                  }}
                  items={raftChannelOptions}
                >
                  <SelectTrigger className="w-full" aria-label={formatMessage({ id: "settings.slackBridge.raftChannel" })}>
                    <SelectValue />
                    <SelectIcon />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectList>
                      {raftChannelOptions.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          <SelectItemText>{option.label}</SelectItemText>
                          <SelectItemIndicator />
                        </SelectItem>
                      ))}
                    </SelectList>
                  </SelectContent>
                </Select>
              </FormField>
              <FormField
                label={formatMessage({ id: "settings.slackBridge.slackChannel" })}
                size="compact"
                labelStyle="plain"
              >
                <Select
                  value={slackChannelId}
                  onValueChange={(value) => {
                    if (value != null) dispatch({ type: "slack_channel", channelId: value });
                  }}
                  items={slackChannelOptions}
                >
                  <SelectTrigger className="w-full" aria-label={formatMessage({ id: "settings.slackBridge.slackChannel" })}>
                    <SelectValue />
                    <SelectIcon />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectList>
                      {slackChannelOptions.map((option) => (
                        <SelectItem key={option.value} value={option.value} disabled={option.disabled}>
                          <SelectItemText>{option.label}</SelectItemText>
                          <SelectItemIndicator />
                        </SelectItem>
                      ))}
                    </SelectList>
                  </SelectContent>
                </Select>
              </FormField>
              <p
                className="text-xs text-black/50 sm:col-start-2 sm:row-start-2"
                data-testid="slack-bridge-channel-membership-hint"
              >
                {formatMessage({ id: "settings.slackBridge.slackChannelMembershipHint" })}
              </p>
              <div
                className="flex items-center gap-2 self-end sm:col-start-3 sm:row-start-1"
                data-testid="slack-bridge-channel-pair-actions"
              >
                <Button size="md" shape="iconText" disabled={!raftChannelId || !slackChannelId || !selectedSlackChannelIsMember} onClick={addPair}>
                  <Plus size={14} />
                  {formatMessage({ id: "settings.slackBridge.addPair" })}
                </Button>
                <Button size="md" shape="iconText" disabled={busy} onClick={() => void refresh()}>
                  <RefreshCw size={14} />
                  {formatMessage({ id: "settings.slackBridge.refreshChannels" })}
                </Button>
              </div>
            </div>
          )}
          <ul className="space-y-2" aria-label={formatMessage({ id: "settings.slackBridge.selectedPairs" })}>
            {pairs.map((pair) => (
              <li key={`${pair.raftChannelId}:${pair.slackChannelId}`} className="flex items-center justify-between gap-3 border border-black bg-brutal-cream px-3 py-2 text-xs font-bold">
                <span>
                  {formatMessage(
                    { id: "settings.slackBridge.channelPair" },
                    {
                      raftName: channelNames.raft.get(pair.raftChannelId),
                      slackName: channelNames.slack.get(pair.slackChannelId),
                    },
                  )}
                </span>
                {canManage && (
                  <Button shape="icon" size="xs" aria-label={formatMessage({ id: "settings.slackBridge.removePair" })} onClick={() => dispatch({ type: "pairs", pairs: pairs.filter((item) => item !== pair) })}>
                    <Trash2 size={12} />
                  </Button>
                )}
              </li>
            ))}
          </ul>
          {!pairChangesValid && pairs.length > 0 && (
            <Banner intent="warning" density="sm">{formatMessage({ id: "settings.slackBridge.pairInvalid" })}</Banner>
          )}
          {canManage && (
            <div className="flex justify-end">
              <Button
                tone="pink"
                size="md"
                disabled={!pairChangesValid || busy || (editingMappings && !mappingBaseline)}
                onClick={() => void mutate(() => editingMappings && mappingBaseline
                  ? applyManagedSlackBridgeChannelPairs({ provider, baseline: mappingBaseline, desiredPairs: pairs })
                  : finishSlackBridgeSetup({ provider, pairs }))}
              >
                {formatMessage({
                  id: editingMappings
                    ? "settings.slackBridge.applyPairChanges"
                    : "settings.slackBridge.finishSetup",
                })}
              </Button>
            </div>
          )}
        </div>
      )}

      {snapshot.stage === "preflight" && (
        <div className="border-2 border-black bg-white p-4">
          <div className="text-sm font-bold">{formatMessage({ id: "settings.slackBridge.preflightTitle" })}</div>
          <p className="mt-1 text-xs text-black/60">{formatMessage({ id: "settings.slackBridge.preflightDescription" })}</p>
          {snapshot.preflight && (
            <PreflightResults preflight={snapshot.preflight} passed={preflightPassed} />
          )}
          {canManage && (
            <Button className="mt-3" tone="pink" size="md" disabled={busy} onClick={() => void mutate(() => verifyAndEnableSlackBridge(provider))}>
              {formatMessage({ id: "settings.slackBridge.retryFinishSetup" })}
            </Button>
          )}
        </div>
      )}

      {snapshot.stage === "enable" && (
        <div className="space-y-3 border-2 border-black bg-white p-4">
          {snapshot.preflight ? (
            <PreflightResults preflight={snapshot.preflight} passed={preflightPassed} />
          ) : (
            <Banner intent="warning" density="sm" icon={<AlertTriangle size={16} />}>
              {formatMessage({ id: "settings.slackBridge.preflightNotPassed" })}
            </Banner>
          )}
          {canManage && (
            <div className="flex justify-end">
              <Button
                tone="pink"
                size="md"
                disabled={busy}
                onClick={() => void mutate(() => preflightPassed
                  ? provider.enable()
                  : verifyAndEnableSlackBridge(provider))}
              >
                {formatMessage({ id: "settings.slackBridge.retryFinishSetup" })}
              </Button>
            </div>
          )}
        </div>
      )}

      {snapshot.stage === "health" && !editingMappings && (
        <HealthPanel
          snapshot={snapshot}
          channelNames={channelNames}
          canManage={canManage}
          onManage={() => dispatch({ type: "edit_mappings" })}
          busy={busy}
          onRefresh={() => void refresh()}
        />
      )}

      {canDisconnect && !disconnectConfirmed && (
        <div className="flex justify-end">
          <Button tone="red" size="sm" disabled={busy} onClick={() => dispatch({ type: "confirm_disconnect" })}>
            {formatMessage({ id: "settings.slackBridge.disconnect" })}
          </Button>
        </div>
      )}
      {canDisconnect && disconnectConfirmed && (
        <div className="space-y-3 border-2 border-black bg-brutal-red/20 p-3" data-testid="slack-bridge-disconnect-confirmation">
          <p className="text-xs font-semibold">{formatMessage({ id: "settings.slackBridge.disconnectDescription" })}</p>
          <div className="flex justify-end gap-2">
            <Button size="sm" disabled={busy} onClick={() => dispatch({ type: "cancel_disconnect" })}>
              {formatMessage({ id: "settings.common.cancel" })}
            </Button>
            <Button
              tone="red"
              size="sm"
              disabled={busy}
              onClick={() => void mutate(() => provider.disconnect!(disconnectConnectionEpoch))}
            >
              {formatMessage({ id: "settings.slackBridge.disconnectConfirm" })}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
