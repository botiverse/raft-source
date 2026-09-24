import { useEffect, useMemo, useState } from "react";
import { useIntl } from "react-intl";
import { SLACK_BRIDGE_FEATURE_FLAG_KEYS } from "@botiverse/raft-shared";
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
import type { SlackBridgeProvisioningProvider, SlackBridgeSetupSnapshot, SlackBridgeSetupStage } from "../settings/slackBridgeProvisioning";
import { isSlackBridgePreflightPassed } from "../settings/slackBridgeProvisioning";
import { slackBridgeProvisioningProvider } from "../settings/slackBridgeProvisioningApi";
import FormField from "../ui/FormField";
import { useServerFeatureFlag } from "../../store/serverFeatureFlags";

const NOT_CONNECTED_VALUE = "__slack_bridge_not_connected__";

export interface SlackBridgeEditor {
  snapshot: SlackBridgeSetupSnapshot | null;
  selectedSlackChannelId: string;
  setSelectedSlackChannelId: (value: string) => void;
  available: boolean;
  apply: (channelId: string) => Promise<void>;
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
  const setSelectedSlackChannelId = (value: string) => setState((current) => ({
    ...current,
    selectedSlackChannelId: value,
  }));

  useEffect(() => {
    let active = true;
    if (!input.canManage || !launchEnabled) {
      return () => { active = false; };
    }
    void slackBridgeProvisioningProvider.load()
      .then((view) => {
        if (!active || view.kind !== "ready") return;
        const current = input.channelId
          ? view.snapshot.channelPairs.find((pair) => pair.raftChannelId === input.channelId)
          : null;
        setState({
          snapshot: view.snapshot,
          selectedSlackChannelId: current?.slackChannelId ?? "",
        });
      })
      .catch(() => {
        if (active) setState({ snapshot: null, selectedSlackChannelId: "" });
      });
    return () => { active = false; };
  }, [input.canManage, input.channelId, launchEnabled]);

  const available = launchEnabled
    && isChannelSlackBridgeSelectionAvailable(snapshot?.stage ?? null);

  const apply = async (channelId: string) => {
    if (!launchEnabled || !snapshot || !available) return;
    const fresh = await slackBridgeProvisioningProvider.load();
    const currentSnapshot = await applyChannelSlackBridgeSelection({
      provider: slackBridgeProvisioningProvider,
      snapshot: fresh.snapshot,
      channelId,
      selectedSlackChannelId,
    });
    setState((current) => ({ ...current, snapshot: currentSnapshot }));
  };

  return { snapshot, selectedSlackChannelId, setSelectedSlackChannelId, available, apply };
}

export function ChannelSlackBridgeField({
  editor,
  visibility,
  disabled,
}: {
  editor: SlackBridgeEditor;
  visibility: "public" | "private";
  disabled?: boolean;
}) {
  const { formatMessage } = useIntl();
  const options = useMemo(() => editor.snapshot?.slackChannels.filter((channel) =>
    !channel.privacyClass || channel.privacyClass === visibility) ?? [], [editor.snapshot, visibility]);
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
              : "settings.slackBridge.channelName" },
          { name: channel.name },
        ),
        disabled: occupied || membershipRequired,
      };
    }),
  ], [editor.selectedSlackChannelId, formatMessage, options, pairedBySlackId]);

  if (!editor.available) return null;

  return (
    <section className="space-y-3 border-t-2 border-black pt-4" data-testid="channel-slack-bridge-field">
      <div>
        <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-black/65">
          <span className="border border-black bg-brutal-lavender px-1.5 py-0.5 text-[10px] text-black">
            {formatMessage({ id: "settings.slackBridge.providerBadge" })}
          </span>
          {formatMessage({ id: "channel.bridge.fieldTitle" })}
        </div>
        <p className="mt-1 text-xs text-black/60">{formatMessage({ id: "channel.bridge.fieldDescription" })}</p>
      </div>
      <FormField label={formatMessage({ id: "channel.bridge.slackChannel" })}>
        <Select
          value={editor.selectedSlackChannelId || NOT_CONNECTED_VALUE}
          disabled={disabled}
          onValueChange={(value) => {
            if (value != null) {
              editor.setSelectedSlackChannelId(value === NOT_CONNECTED_VALUE ? "" : value);
            }
          }}
          items={selectOptions}
        >
          <SelectTrigger className="w-full" aria-label={formatMessage({ id: "channel.bridge.slackChannel" })}>
            <SelectValue />
            <SelectIcon />
          </SelectTrigger>
          <SelectContent>
            <SelectList>
              {selectOptions.map((option) => (
                <SelectItem key={option.value} value={option.value} disabled={option.disabled}>
                  <SelectItemText>{option.label}</SelectItemText>
                  <SelectItemIndicator />
                </SelectItem>
              ))}
            </SelectList>
          </SelectContent>
        </Select>
      </FormField>
    </section>
  );
}
