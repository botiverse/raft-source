import { ComboboxSelect } from "@botiverse/raft-ui/wip";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useIntl } from "react-intl";
import { SLACK_BRIDGE_FEATURE_FLAG_KEYS } from "@botiverse/raft-shared";
import {
  Badge,
  Button,
  FormSection,
  ListRow,
  ListRowBody,
  ListRowDescription,
  ListRowTitle,
} from "@botiverse/raft-ui";
import ConfirmDialog from "../ConfirmDialog";
import type { SlackBridgeProvisioningProvider, SlackBridgeSetupSnapshot, SlackBridgeSetupStage } from "../settings/slackBridgeProvisioning";
import { isSlackBridgePreflightPassed } from "../settings/slackBridgeProvisioning";
import { slackBridgeProvisioningProvider } from "../settings/slackBridgeProvisioningApi";
import { SLACK_BRIDGE_FAILURE_REASON_MESSAGE_ID } from "../settings/slackBridgeErrors";
import FormField from "../ui/FormField";
import { useServerFeatureFlag } from "../../store/serverFeatureFlags";

const NOT_CONNECTED_VALUE = "__slack_bridge_not_connected__";

export interface SlackBridgeEditor {
  snapshot: SlackBridgeSetupSnapshot | null;
  selectedSlackChannelId: string;
  setSelectedSlackChannelId: (value: string) => void;
  available: boolean;
  apply: (channelId: string) => Promise<void>;
  refresh: () => Promise<void>;
  /** This channel's saved pair, when it has one; carries `invalidReason`
   *  once the pair no longer matches current channel authority. */
  currentPair?: SlackBridgeSetupSnapshot["channelPairs"][number] | null;
}

export function isChannelSlackBridgeSelectionAvailable(stage: SlackBridgeSetupStage | null): boolean {
  return stage === "health";
}

export async function applyChannelSlackBridgeSelection(input: {
  provider: SlackBridgeProvisioningProvider;
  snapshot: SlackBridgeSetupSnapshot;
  channelId: string;
  selectedSlackChannelId: string;
}): Promise<SlackBridgeSetupSnapshot> {
  let currentSnapshot = input.snapshot;
  const currentPair = currentSnapshot.channelPairs.find((pair) => pair.raftChannelId === input.channelId);
  if (currentPair?.slackChannelId === input.selectedSlackChannelId || (!currentPair && !input.selectedSlackChannelId)) {
    return currentSnapshot;
  }

  if (currentPair) {
    if (!currentPair.bindingEpoch || !input.provider.removeChannelPair) {
      throw new Error("slack_bridge_binding_coordinates_unavailable");
    }
    const removed = await input.provider.removeChannelPair({
      raftChannelId: currentPair.raftChannelId,
      slackChannelId: currentPair.slackChannelId,
      expectedBindingEpoch: currentPair.bindingEpoch,
    });
    currentSnapshot = removed.snapshot;
  }

  if (input.selectedSlackChannelId) {
    const desiredPairs = [
      ...currentSnapshot.channelPairs.map(({ raftChannelId, slackChannelId }) => ({ raftChannelId, slackChannelId })),
      { raftChannelId: input.channelId, slackChannelId: input.selectedSlackChannelId },
    ];
    await input.provider.saveChannelPairs(desiredPairs);
    const preflight = await input.provider.runPreflight();
    if (!isSlackBridgePreflightPassed(preflight.snapshot.preflight)) {
      throw new Error("slack_bridge_preflight_failed");
    }
    currentSnapshot = (await input.provider.enable()).snapshot;
  }
  return currentSnapshot;
}

export function useChannelSlackBridgeEditor(input: {
  channelId?: string;
  visibility: "public" | "private";
  canManage: boolean;
}): SlackBridgeEditor {
  const launchEnabled = useServerFeatureFlag(SLACK_BRIDGE_FEATURE_FLAG_KEYS.master).enabled;
  const [state, setState] = useState<{
    snapshot: SlackBridgeSetupSnapshot | null;
    selectedSlackChannelId: string;
  }>({ snapshot: null, selectedSlackChannelId: "" });
  const { snapshot, selectedSlackChannelId } = state;
  const loadRevision = useRef({ value: 0 });
  const setSelectedSlackChannelId = useCallback((value: string) => setState((current) => ({
    ...current,
    selectedSlackChannelId: value,
  })), []);

  useEffect(() => {
    const counter = loadRevision.current;
    const revision = ++counter.value;
    if (!input.canManage || !launchEnabled) {
      return () => { counter.value++; };
    }
    void slackBridgeProvisioningProvider.load()
      .then((view) => {
        if (counter.value !== revision || view.kind !== "ready") return;
        const current = input.channelId
          ? view.snapshot.channelPairs.find((pair) => pair.raftChannelId === input.channelId)
          : null;
        setState({
          snapshot: view.snapshot,
          selectedSlackChannelId: current?.slackChannelId ?? "",
        });
      })
      .catch(() => {
        if (counter.value === revision) setState({ snapshot: null, selectedSlackChannelId: "" });
      });
    return () => { counter.value++; };
  }, [input.canManage, input.channelId, launchEnabled]);

  const available = launchEnabled
    && isChannelSlackBridgeSelectionAvailable(snapshot?.stage ?? null);

  const apply = useCallback(async (channelId: string) => {
    if (!launchEnabled || !snapshot || !available) return;
    const revision = ++loadRevision.current.value;
    const fresh = await slackBridgeProvisioningProvider.load();
    const currentSnapshot = await applyChannelSlackBridgeSelection({
      provider: slackBridgeProvisioningProvider,
      snapshot: fresh.snapshot,
      channelId,
      selectedSlackChannelId,
    });
    if (loadRevision.current.value === revision) {
      setState((current) => ({ ...current, snapshot: currentSnapshot }));
    }
  }, [launchEnabled, snapshot, available, selectedSlackChannelId]);

  const refresh = useCallback(async () => {
    const revision = ++loadRevision.current.value;
    const fresh = await slackBridgeProvisioningProvider.load();
    if (loadRevision.current.value === revision) {
      // Keep a choice the user has made but not yet saved.
      setState((current) => ({ ...current, snapshot: fresh.snapshot }));
    }
  }, []);

  const currentPair = useMemo(() => (input.channelId
    ? snapshot?.channelPairs.find((pair) => pair.raftChannelId === input.channelId) ?? null
    : null), [input.channelId, snapshot]);

  return useMemo(
    () => ({ snapshot, selectedSlackChannelId, setSelectedSlackChannelId, available, apply, refresh, currentPair }),
    [snapshot, selectedSlackChannelId, setSelectedSlackChannelId, available, apply, refresh, currentPair],
  );
}

/** The channel's Slack Bridge pick as a raft-ui FormSection (DS
 *  `rf-drawer__section`): heading with the provider badge, a line on what it
 *  does, then the Slack channel field. `className` adjusts the section's own
 *  spacing for a host that is not a run of sections (the create dialog). */
export function ChannelSlackBridgeField({
  editor,
  disabled,
  className,
  bare = false,
}: {
  editor: SlackBridgeEditor;
  /** Only the field, its help and Refresh, without the section heading: the body of the channel details' Slack dialog. */
  bare?: boolean;
  /** Retained in the caller contract: pairing no longer depends on this
   *  channel's visibility, so the field ignores it. */
  visibility?: "public" | "private";
  disabled?: boolean;
  className?: string;
}) {
  const { formatMessage } = useIntl();
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState(false);
  // Every observed Slack channel is selectable — pairing across
  // public/private is allowed; each platform keeps its own visibility. The
  // option label marks the Slack side's class so the cross-class choice is
  // explicit.
  const options = useMemo(() => editor.snapshot?.slackChannels ?? [], [editor.snapshot]);
  const invalidReason = editor.currentPair?.slackChannelId === editor.selectedSlackChannelId
    ? editor.currentPair?.invalidReason
    : undefined;
  const pairedBySlackId = useMemo(() => new Map(
    editor.snapshot?.channelPairs.map((pair) => [pair.slackChannelId, pair.raftChannelId]) ?? [],
  ), [editor.snapshot]);
  const selectOptions = useMemo(() => [
    {
      value: NOT_CONNECTED_VALUE,
      label: formatMessage({ id: "channel.bridge.notConnected" }),
      disabled: false,
    },
    ...options.map((channel) => {
      const pairedRaftChannelId = pairedBySlackId.get(channel.id);
      const occupied = !!pairedRaftChannelId && channel.id !== editor.selectedSlackChannelId;
      const membershipRequired = channel.isMember !== true;
      return {
        value: channel.id,
        label: formatMessage(
          { id: membershipRequired
            ? "settings.slackBridge.channelMembershipRequiredOption"
            : occupied
              ? "channel.bridge.alreadyPairedOption"
              : channel.privacyClass === "private"
                ? "settings.slackBridge.channelNamePrivate"
                : channel.privacyClass === "public"
                  ? "settings.slackBridge.channelNamePublic"
                  : "settings.slackBridge.channelName" },
          { name: channel.name },
        ),
        disabled: occupied || membershipRequired,
      };
    }),
  ], [editor.selectedSlackChannelId, formatMessage, options, pairedBySlackId]);

  const { setSelectedSlackChannelId } = editor;
  const handleValueChange = useCallback((value: string | number | null) => {
    if (typeof value === "string") {
      setSelectedSlackChannelId(value === NOT_CONNECTED_VALUE ? "" : value);
    }
  }, [setSelectedSlackChannelId]);

  const refreshChannels = useCallback(async () => {
    setRefreshing(true);
    setRefreshError(false);
    try {
      await editor.refresh();
    } catch {
      setRefreshError(true);
    } finally {
      setRefreshing(false);
    }
  }, [editor]);

  if (!editor.available) return null;

  const body = (
    <>
      <FormField
        label={formatMessage({ id: "channel.bridge.slackChannel" })}
        error={invalidReason ? (
          <span data-testid="channel-slack-bridge-pair-invalid">
            {formatMessage(
              { id: "settings.slackBridge.pairNoLongerValid" },
              { reason: formatMessage({ id: SLACK_BRIDGE_FAILURE_REASON_MESSAGE_ID[invalidReason] }) },
            )}
          </span>
        ) : undefined}
      >
        <ComboboxSelect
          value={editor.selectedSlackChannelId || NOT_CONNECTED_VALUE}
          disabled={disabled}
          onValueChange={handleValueChange}
          options={selectOptions}
          aria-label={formatMessage({ id: "channel.bridge.slackChannel" })}
          placeholder={formatMessage({ id: "settings.slackBridge.searchChannels" })}
          emptyContent={formatMessage({ id: "settings.slackBridge.noMatchingChannels" })}
          showArrow
          autoHighlight
        />
      </FormField>
      <p className="text-caption text-foreground-hint">
        {formatMessage({ id: "settings.slackBridge.slackChannelMembershipHint" })}
      </p>
      <Button
        type="button"
        size="md"
        variant="ghost"
        disabled={disabled}
        loading={refreshing}
        loadingLabel={formatMessage({ id: "common.loading" })}
        onClick={refreshChannels}
      >
        {formatMessage({ id: "settings.slackBridge.refreshChannels" })}
      </Button>
      {refreshError && (
        <p role="alert" className="text-footnote text-foreground-muted">
          {formatMessage({ id: "settings.slackBridge.operationFailed" })}
        </p>
      )}
    </>
  );
  if (bare) return <div className={`stack-y-3 ${className ?? ""}`} data-testid="channel-slack-bridge-field">{body}</div>;

  return (
    <FormSection
      className={className}
      data-testid="channel-slack-bridge-field"
      title={(
        <span className="flex items-center gap-2">
          <Badge appearance="outline" data-testid="channel-slack-bridge-provider-badge">
            {formatMessage({ id: "settings.slackBridge.providerBadge" })}
          </Badge>
          {formatMessage({ id: "channel.bridge.fieldTitle" })}
        </span>
      )}
    >
      {body}
    </FormSection>
  );
}

/**
 * The channel details' Slack row (Channel settings, raft-design channel.md, stdrc 2026-11-10): the pairing's state
 * in the row's description and Connect or Change at its end, which opens a dialog with the Slack channel, its help
 * and Refresh. The dialog's own Connect applies it: connecting has a side effect, so it is a button that names it,
 * never part of the name and description's Save (DS Forms, "When a change takes effect").
 */
export function ChannelSlackBridgeRow({
  editor,
  channelId,
  channelName,
  disabled,
}: {
  editor: SlackBridgeEditor;
  channelId: string;
  channelName: string;
  disabled?: boolean;
}) {
  const { formatMessage } = useIntl();
  const [open, setOpen] = useState(false);
  const currentId = editor.currentPair?.slackChannelId ?? "";
  // The saved pairing when the dialog closes, not when it was rendered: after Connect it is the new one.
  const currentIdRef = useRef(currentId);
  currentIdRef.current = currentId;
  const { setSelectedSlackChannelId } = editor;
  const openDialog = useCallback(() => {
    setSelectedSlackChannelId(currentIdRef.current);
    setOpen(true);
  }, [setSelectedSlackChannelId]);
  const closeDialog = useCallback(() => {
    // An unapplied pick doesn't outlive its dialog.
    setSelectedSlackChannelId(currentIdRef.current);
    setOpen(false);
  }, [setSelectedSlackChannelId]);
  const apply = useCallback(async () => {
    try {
      await editor.apply(channelId);
    } catch {
      throw new Error(formatMessage({ id: "channel.details.slackFailed" }));
    }
  }, [channelId, editor, formatMessage]);

  if (!editor.available) return null;
  const current = currentId ? editor.snapshot?.slackChannels.find((channel) => channel.id === currentId) : undefined;
  const invalidReason = editor.currentPair?.invalidReason;
  const status = invalidReason
    ? formatMessage(
      { id: "settings.slackBridge.pairNoLongerValid" },
      { reason: formatMessage({ id: SLACK_BRIDGE_FAILURE_REASON_MESSAGE_ID[invalidReason] }) },
    )
    : currentId
      // A pairing whose Slack channel this workspace no longer lists: connected, with no machine id for a name.
      ? current ? formatMessage({ id: "channel.details.slackConnected" }, { name: current.name }) : formatMessage({ id: "channel.details.slackConnectedUnnamed" })
      : formatMessage({ id: "channel.details.slackNotConnected" });
  const selected = editor.selectedSlackChannelId;
  return (
    <ListRow variant="plain" interactive={false} data-testid="channel-settings-slack">
      <ListRowBody>
        <ListRowTitle id="channel-settings-slack-label">{formatMessage({ id: "channel.details.slackTitle" })}</ListRowTitle>
        <ListRowDescription wrap data-testid="channel-settings-slack-status">
          {invalidReason ? <span className="text-warning-strong" data-testid="channel-slack-bridge-pair-invalid">{status}</span> : status}
        </ListRowDescription>
      </ListRowBody>
      <Button
        type="button"
        size="md"
        variant="outline"
        className="shrink-0"
        disabled={disabled}
        onClick={openDialog}
        aria-describedby="channel-settings-slack-label"
        data-testid="channel-settings-slack-open"
      >
        {formatMessage({ id: currentId ? "channel.details.slackChange" : "channel.details.slackConnect" })}
      </Button>
      {open ? (
        <ConfirmDialog
          size="md"
          plainMessage
          title={formatMessage({ id: "channel.details.slackDialogTitle" }, { channel: channelName })}
          message={(
            <div className="stack-y-4">
              <p className="text-subhead text-foreground-muted">{formatMessage({ id: "channel.details.slackDialogLead" })}</p>
              <ChannelSlackBridgeField editor={editor} bare />
            </div>
          )}
          confirmLabel={formatMessage({ id: selected ? "channel.details.slackConnect" : "channel.details.slackSave" })}
          confirmVariant="primary"
          confirmDisabled={selected === currentId}
          onConfirm={apply}
          onClose={closeDialog}
          confirmTestId="channel-settings-slack-confirm"
        />
      ) : null}
    </ListRow>
  );
}
