import { useMemo, useRef, useState } from "react";
import { useIntl } from "react-intl";
import { formatNameValidationError } from "../../i18n/nameValidation";
import { Check, Search, Hash, Lock } from "lucide-react";
import { SegmentedControl, SegmentedControlItem, SegmentedControlLabel } from "raft-ui";
import { useAgentStore } from "../../store/agentStore";
import { useChannelStore } from "../../store/channelStore";
import { useServerStore } from "../../store/serverStore";
import { useAuthStore } from "../../store/authStore";
import { validateNameReason, PLAN_CONFIG, getEffectiveLimits } from "@botiverse/raft-shared";
import type { ServerPlan } from "@botiverse/raft-shared";
import { useAppNavigate } from "../../hooks/useAppNavigate";
import DialogCard from "../ui/DialogCard";
import Banner from "../ui/Banner";
import SectionEyebrow from "../ui/SectionEyebrow";
import AvatarSlot from "../ui/AvatarSlot";
import FormField from "../ui/FormField";
import { usePeopleSuggestionSearch } from "../../hooks/usePeopleSuggestionSearch";
import { useServerPermissions } from "../../hooks/useServerPermissions";
import type { PeopleSuggestionCandidate } from "../../utils/peopleSuggestionSearch";
import { ChannelSlackBridgeField, useChannelSlackBridgeEditor } from "./ChannelSlackBridgeField";

interface ArchivedCollision {
  archivedChannelId: string;
  archivedChannelName: string;
  canUnarchiveArchivedChannel: boolean;
}

interface PrefillProps {
  /** Prefilled values from an action card (per #proj-approval msg=40cb9342). */
  prefilledName?: string;
  prefilledDescription?: string;
  prefilledVisibility?: "public" | "private";
  prefilledAgentIds?: string[];
  prefilledHumanIds?: string[];
  /** Keep the current surface after create; used by orchestrators that chain dialogs. */
  stayOnCreate?: boolean;
  /** Fired after successful create — used by ActionCard to mark-executed. */
  onCreated?: (channel: { id: string; name: string }) => void;
  /**
   * Action-card funnel hook: fired right before the create API call (after
   * client-side validation passes). Records `execute_attempt` for the
   * dialog-driven path. No-op for non-card launches.
   */
  onSubmitStart?: () => void;
  /**
   * Action-card funnel hook: fired when the create API throws. Records
   * `execute_fail`. Receives the raw error so the caller can classify.
   */
  onSubmitError?: (err: unknown) => void;
}

export default function CreateChannelDialog({
  onClose,
  prefilledName,
  prefilledDescription,
  prefilledVisibility,
  prefilledAgentIds,
  prefilledHumanIds,
  stayOnCreate = false,
  onCreated,
  onSubmitStart,
  onSubmitError,
}: {
  onClose: () => void;
} & PrefillProps) {
  const { formatMessage } = useIntl();
  const [name, setName] = useState(prefilledName ?? "");
  const [description, setDescription] = useState(prefilledDescription ?? "");
  const [memberSearch, setMemberSearch] = useState("");
  const [visibility, setVisibility] = useState<"public" | "private">(prefilledVisibility ?? "public");
  const [selectedAgentIds, setSelectedAgentIds] = useState<Set<string>>(new Set(prefilledAgentIds ?? []));
  const [selectedHumanIds, setSelectedHumanIds] = useState<Set<string>>(new Set(prefilledHumanIds ?? []));
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [archivedCollision, setArchivedCollision] = useState<ArchivedCollision | null>(null);
  const [unarchiving, setUnarchiving] = useState(false);
  const [createdChannelForBridge, setCreatedChannelForBridge] = useState<{ id: string; name: string } | null>(null);
  const submitInFlightRef = useRef(false);
  const allAgents = useAgentStore((s) => s.agents);
  const members = useServerStore((s) => s.members);
  const currentUser = useAuthStore((s) => s.user);
  const createChannel = useChannelStore((s) => s.createChannel);
  const unarchiveChannel = useChannelStore((s) => s.unarchiveChannel);
  const channels = useChannelStore((s) => s.channels);
  const nav = useAppNavigate();
  const { capabilities } = useServerPermissions();
  const bridgeEditor = useChannelSlackBridgeEditor({
    visibility,
    canManage: capabilities.createChannels,
  });

  const plan = (useServerStore((s) => s.current?.plan) || "free") as ServerPlan;
  const maxChannels = getEffectiveLimits(plan).maxChannels;
  const atLimit = maxChannels !== -1 && channels.length >= maxChannels;

  const memberSearchCandidates = useMemo<PeopleSuggestionCandidate<(typeof allAgents)[number] | (typeof members)[number]>[]>(() => [
      ...allAgents.filter((agent) => !agent.deletedAt).map((agent) => ({
        kind: "agent" as const,
        id: agent.id,
        value: agent,
        handle: agent.name,
        displayName: agent.displayName,
        description: agent.description,
      })),
      ...members.filter((member) => member.userId !== currentUser?.id).map((member) => ({
        kind: "human" as const,
        id: member.userId,
        value: member,
        handle: member.name,
        displayName: member.displayName,
        description: member.description,
        sourceServerLabel: member.serverName || member.serverSlug,
      })),
    ], [allAgents, currentUser?.id, members]);
  const { entries: memberSearchEntries, ranked: rankedMembers } = usePeopleSuggestionSearch(
    memberSearch,
    memberSearchCandidates,
  );
  const filteredAgents = rankedMembers.filter((candidate) => candidate.kind === "agent").map((candidate) => candidate.value as (typeof allAgents)[number]);
  const filteredHumans = rankedMembers.filter((candidate) => candidate.kind === "human").map((candidate) => candidate.value as (typeof members)[number]);
  const hasFilteredMembers = filteredAgents.length > 0 || filteredHumans.length > 0;

  const toggleAgent = (agentId: string) => {
    setSelectedAgentIds((prev) => {
      const next = new Set(prev);
      if (next.has(agentId)) {
        next.delete(agentId);
      } else {
        next.add(agentId);
      }
      return next;
    });
  };

  const toggleHuman = (userId: string) => {
    setSelectedHumanIds((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) {
        next.delete(userId);
      } else {
        next.add(userId);
      }
      return next;
    });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitInFlightRef.current) return;
    setError("");
    setArchivedCollision(null);
    const nameError = formatNameValidationError(
      validateNameReason(name),
      "channel.create.nameFieldName",
      formatMessage,
    );
    if (nameError) {
      setError(nameError);
      return;
    }
    submitInFlightRef.current = true;
    setSubmitting(true);
    // Funnel hook: dialog-driven `execute_attempt` (action-card flow only).
    onSubmitStart?.();
    try {
      const channel = createdChannelForBridge ?? await createChannel(
          name.trim(),
          description.trim() || undefined,
          {
            visibility,
            agentIds: [...selectedAgentIds],
            userIds: [...selectedHumanIds],
          }
        );
      try {
        await bridgeEditor.apply(channel.id);
      } catch {
        setCreatedChannelForBridge({ id: channel.id, name: channel.name });
        setError(formatMessage({ id: "channel.bridge.partialFailure" }));
        return;
      }
      onCreated?.({ id: channel.id, name: channel.name });
      onClose();
      if (!stayOnCreate) {
        nav.toChannel(channel.id);
      }
    } catch (err: unknown) {
      const axiosErr = err as {
        response?: {
          data?: {
            error?: string;
            code?: string;
            archivedChannelId?: string;
            archivedChannelName?: string;
            archivedChannelType?: string;
            canUnarchiveArchivedChannel?: boolean;
          };
        };
      };
      const body = axiosErr.response?.data;
      if (
        body?.code === "archived_name_collision"
        && body.archivedChannelId
        && body.archivedChannelName
        && (body.archivedChannelType === "channel" || body.archivedChannelType === "private")
      ) {
        setArchivedCollision({
          archivedChannelId: body.archivedChannelId,
          archivedChannelName: body.archivedChannelName,
          canUnarchiveArchivedChannel: body.canUnarchiveArchivedChannel === true,
        });
      } else {
        setError(body?.error || formatMessage({ id: "channel.create.failedCreate" }));
      }
      // Funnel hook: dialog-driven `execute_fail`. Fired for both archived-
      // collision and generic errors — both are the same product event
      // ("user submitted, server rejected"). Caller classifies.
      onSubmitError?.(err);
    } finally {
      submitInFlightRef.current = false;
      setSubmitting(false);
    }
  };

  const handleUnarchiveCollision = async () => {
    if (!archivedCollision) return;
    setUnarchiving(true);
    try {
      const channel = await unarchiveChannel(archivedCollision.archivedChannelId);
      onClose();
      nav.toChannel(channel.id);
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: { error?: string } } };
      setError(axiosErr.response?.data?.error || formatMessage({ id: "channel.create.failedUnarchive" }));
    } finally {
      setUnarchiving(false);
    }
  };

  const hasMembers = memberSearchEntries.length > 0;

  return (
    <DialogCard title={formatMessage({ id: "channel.create.title" })} onClose={onClose}>
        <form onSubmit={handleSubmit} className="space-y-4">
          {atLimit && (
            <Banner intent="warning" className="font-bold">
              {formatMessage(
                { id: "channel.create.limitReached" },
                { used: channels.length, max: maxChannels, plan: PLAN_CONFIG[plan].displayName },
              )}{" "}
              <button
                type="button"
                onClick={() => {
                  onClose();
                  nav.toSettings("billing");
                }}
                className="font-bold text-black underline"
              >
                {formatMessage({ id: "channel.create.upgradeForMore" })}
              </button>
            </Banner>
          )}
          {error && !atLimit && (
            <Banner intent="warning" className="font-bold">
              {error}
            </Banner>
          )}
          {archivedCollision && (
            <Banner intent="warning" className="space-y-2">
              <p className="font-bold">
                {formatMessage(
                  { id: "channel.create.archivedNameHeld" },
                  {
                    name: archivedCollision.archivedChannelName,
                    // <name> keeps the mono styling INSIDE the message so translators
                    // can move it. Splitting the sentence around a bare <span> is
                    // exactly what hid this string from both scanners.
                    mono: (chunks: React.ReactNode) => (
                      <span key="archived-name" className="font-mono">{chunks}</span>
                    ),
                  },
                )}
              </p>
              <p className="text-xs text-black/70">
                {formatMessage({
                  id: archivedCollision.canUnarchiveArchivedChannel
                    ? "channel.create.archivedCanManage"
                    : "channel.create.archivedCannotManage",
                })}
              </p>
              <div className="flex flex-wrap gap-2">
                {archivedCollision.canUnarchiveArchivedChannel && (
                  <button
                    type="button"
                    onClick={handleUnarchiveCollision}
                    disabled={unarchiving}
                    className="btn-brutal-sm bg-brutal-lime px-2 py-1 text-xs disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {unarchiving ? formatMessage({ id: "channel.create.unarchiving" }) : formatMessage({ id: "channel.create.unarchive" })}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    setArchivedCollision(null);
                    setName("");
                  }}
                  className="btn-brutal-sm bg-white px-2 py-1 text-xs"
                >
                  {formatMessage({ id: "channel.create.changeName" })}
                </button>
              </div>
            </Banner>
          )}
          <FormField label={formatMessage({ id: "channel.create.nameLabel" })} required>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="input-brutal w-full"
              placeholder={formatMessage({ id: "channel.create.namePlaceholder" })}
              required
              autoFocus
            />
          </FormField>
          <FormField label={formatMessage({ id: "channel.create.descriptionLabel" })} optional>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="input-brutal w-full"
              placeholder={formatMessage({ id: "channel.create.descriptionPlaceholder" })}
              rows={2}
            />
          </FormField>
          <FormField label={formatMessage({ id: "channel.create.visibilityLabel" })}>
            <SegmentedControl
              value={visibility}
              onValueChange={setVisibility}
              aria-label={formatMessage({ id: "channel.create.visibilityAriaLabel" })}
            >
              <SegmentedControlItem value="public">
                <Hash size={12} />
                <SegmentedControlLabel>{formatMessage({ id: "channel.create.public" })}</SegmentedControlLabel>
              </SegmentedControlItem>
              <SegmentedControlItem value="private">
                <Lock size={12} />
                <SegmentedControlLabel>{formatMessage({ id: "channel.create.private" })}</SegmentedControlLabel>
              </SegmentedControlItem>
            </SegmentedControl>
          </FormField>
          <FormField label={formatMessage({ id: "channel.create.membersLabel" })} optional>
            {hasMembers ? (
              <div className="space-y-2">
                <div className="relative">
                  <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-black/40" />
                  <input
                    type="text"
                    value={memberSearch}
                    onChange={(e) => setMemberSearch(e.target.value)}
                    className="input-brutal input-member-search w-full pl-9"
                    placeholder={formatMessage({ id: "channel.create.membersSearchPlaceholder" })}
                  />
                </div>

                <div className="border-2 border-black bg-white shadow-brutal-sm max-h-48 overflow-y-auto">
                  {/* Agents section */}
                  {filteredAgents.length > 0 && (
                    <>
                      <SectionEyebrow as="div" className="px-3 py-1.5 bg-white/50">
                        {formatMessage({ id: "channel.create.agents" })}
                      </SectionEyebrow>
                      {filteredAgents.map((agent) => {
                        const selected = selectedAgentIds.has(agent.id);
                        return (
                          <button
                            key={agent.id}
                            type="button"
                            onClick={() => toggleAgent(agent.id)}
                            className={`flex w-full items-center gap-2 px-3 py-1.5 text-sm font-medium text-black transition-colors ${
                              selected ? "bg-brutal-pink/20" : "hover:bg-soft-signal"
                            }`}
                          >
                            <AvatarSlot context="sidebar-list" type="agent" agentAvatarUrl={agent.avatarUrl} />
                            <span className="flex-1 text-left truncate">{agent.displayName || agent.name}</span>
                            {selected && <Check size={14} className="shrink-0 text-brutal-pink" />}
                          </button>
                        );
                      })}
                    </>
                  )}

                  {/* Humans section */}
                  {filteredHumans.length > 0 && (
                    <>
                      <SectionEyebrow as="div" className="px-3 py-1.5 bg-white/50">
                        {formatMessage({ id: "channel.create.humans" })}
                      </SectionEyebrow>
                      {filteredHumans.map((human) => {
                        const selected = selectedHumanIds.has(human.userId);
                        return (
                          <button
                            key={human.userId}
                            type="button"
                            onClick={() => toggleHuman(human.userId)}
                            className={`flex w-full items-center gap-2 px-3 py-1.5 text-sm font-medium text-black transition-colors ${
                              selected ? "bg-brutal-pink/20" : "hover:bg-soft-signal"
                            }`}
                          >
                            <AvatarSlot context="sidebar-list" type="human" humanPlaceholder />
                            <span className="flex-1 text-left truncate">{human.displayName || human.name}</span>
                            {selected && <Check size={14} className="shrink-0 text-brutal-pink" />}
                          </button>
                        );
                      })}
                    </>
                  )}

                  {!hasFilteredMembers && (
                    <div className="px-3 py-4 text-sm text-black/50 font-mono text-center">
                      {formatMessage({ id: "channel.create.noMatchesFor" }, { query: memberSearch.trim() })}
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="text-sm text-black/50 font-mono">{formatMessage({ id: "channel.create.noMembersAvailable" })}</div>
            )}
          </FormField>
          <ChannelSlackBridgeField editor={bridgeEditor} visibility={visibility} disabled={submitting || !!createdChannelForBridge} />
          <div className="flex justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="btn-brutal bg-white px-4 py-2 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {formatMessage({ id: "settings.common.cancel" })}
            </button>
            <button
              type="submit"
              disabled={atLimit || submitting}
              className="btn-brutal bg-brutal-pink px-4 py-2 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {submitting ? formatMessage({ id: "channel.create.creating" }) : formatMessage({ id: "channel.create.title" })}
            </button>
          </div>
        </form>
    </DialogCard>
  );
}
