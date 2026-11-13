// AddMembersDialog — opened from an `<ActionCard>` whose action is
// `channel:add_member`. The agent prefilled a list of humans and agents
// it wants pulled into a specific channel; this dialog shows that list
// with each row toggleable so the human can deselect anyone they don't
// want added.
//
// Contract (per stdrc 2026-05-11 #proj-permission msg=670d903f):
//   - Visual mirrors ChannelMembers panel so it feels familiar.
//   - One-click "Add Members" commits everything selected under the
//     human's identity using the existing /channels/:id/members API.
//   - The agent's list is a suggestion. The dialog reports back the
//     actual add list (post-deselection) so the action card's "Done"
//     state records what really happened, not what the agent proposed.
//   - Already-members are filtered out client-side so the dialog only
//     shows net new additions; if everyone is already a member, the
//     submit button is disabled with a hint.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChannelIcon } from "./channelKindIcon";
import DialogCard from "../ui/DialogCard";
import { useIntl } from "react-intl";
import Banner from "../ui/Banner";
import { useAgentStore } from "../../store/agentStore";
import { useServerStore } from "../../store/serverStore";
import { useChannelStore } from "../../store/channelStore";
import { useChannelMembers } from "../../hooks/useChannelMembers";
import { isLocalProjectionMember } from "../../utils/channelLocalMembership";
import { Button, Card, IconTile } from "@botiverse/raft-ui";
import MemberPicker, { agentCandidate, serverMemberCandidate } from "../pickers/MemberPicker";
import type { MemberKind } from "../pickers/MemberPicker";
import { DialogCardFooter, DialogCommit } from "../ui/NarrowDialog";

const MEMBER_KINDS: readonly MemberKind[] = ["human", "agent"];

interface Props {
  channelId: string;
  prefilledHumanIds?: string[];
  prefilledAgentIds?: string[];
  /** Why the agent prepared this — surfaced as a quote near the top. */
  draftHint?: string;
  onClose: () => void;
  /**
   * Fires after the dialog actually adds the selected members. The argument
   * carries the channelId and the IDs that were successfully added — only
   * those that the user kept selected AND whose add API call succeeded.
   * The ActionCard caller uses this to flip the card to "Done" with the
   * effective result, not the agent's original suggestion.
   */
  onSubmitted: (result: {
    channelId: string;
    channelName: string;
    addedHumanIds: string[];
    addedAgentIds: string[];
  }) => void;
  /**
   * Action-card funnel hook: fired right before the batch add starts (after
   * client-side validation). Records `execute_attempt` for the dialog-
   * driven path. No-op for non-card launches.
   */
  onSubmitStart?: () => void;
  /**
   * Action-card funnel hook: fired when the batch add fails (no rows
   * added, or thrown error). Records `execute_fail`. Receives the raw
   * error.
   */
  onSubmitError?: (err: unknown) => void;
  actionCardMessageId?: string;
  actionCardConfirmationVersion?: number;
}

export default function AddMembersDialog({
  channelId,
  prefilledHumanIds,
  prefilledAgentIds,
  draftHint,
  onClose,
  onSubmitted,
  onSubmitStart,
  onSubmitError,
  actionCardMessageId,
  actionCardConfirmationVersion,
}: Props) {
  const { formatMessage } = useIntl();
  const channels = useChannelStore((s) => s.channels);
  const members = useServerStore((s) => s.members);
  const agents = useAgentStore((s) => s.agents);
  const { channelAgents, channelHumans, loadMembers, addMembers } = useChannelMembers(channelId);
  const channel = channels.find((c) => c.id === channelId) ?? null;

  // Already-members get filtered out so the dialog only proposes net new
  // additions. We compute this once on mount (after loadMembers populates)
  // and again whenever channelAgents/channelHumans changes.
  const existingHumanIds = useMemo(
    () => new Set(channelHumans
      .filter((m) => isLocalProjectionMember(m, channel))
      .map((m) => m.id)),
    [channelHumans, channel],
  );
  const existingAgentIds = useMemo(
    () => new Set(channelAgents.map((a) => a.id)),
    [channelAgents],
  );

  // Candidate lists: prefilled IDs that aren't already members and that
  // we can resolve to a known server member / agent.
  const candidateHumans = useMemo(() => {
    return (prefilledHumanIds ?? [])
      .filter((id) => !existingHumanIds.has(id))
      .map((id) => members.find((m) => m.userId === id))
      .filter((m): m is NonNullable<typeof m> => !!m);
  }, [prefilledHumanIds, existingHumanIds, members]);

  const candidateAgents = useMemo(() => {
    return (prefilledAgentIds ?? [])
      .filter((id) => !existingAgentIds.has(id))
      .map((id) => agents.find((a) => a.id === id))
      .filter((a): a is NonNullable<typeof a> => !!a);
  }, [prefilledAgentIds, existingAgentIds, agents]);

  // Selection state — every candidate starts selected. Toggling deselects.
  const [selectedHumanIds, setSelectedHumanIds] = useState<Set<string>>(new Set());
  const [selectedAgentIds, setSelectedAgentIds] = useState<Set<string>>(new Set());

  // Seed-once guards. The candidate memos (above) recompute when their inputs
  // change (`prefilledHumanIds` / `existingHumanIds` / `members` / `agents`
  // etc.), so a new array reference can appear even when the logical
  // candidate set is unchanged — for example when an upstream Zustand store
  // churns mid-dialog. Without these guards, an async store update would
  // re-fire the effects and **wipe the user's accumulated toggles**.
  //
  // Caught by @铁根 in PR #2530 review (msg=67842e10) as a real latent bug
  // that the rule was correctly indicating, not an FP. The same idempotency-lock pattern (per PR #2529) — `useRef` because the seeded flag never affects render.
  //
  // The `candidates.length === 0` clause defers seeding until the async
  // candidate set has actually arrived; without it, the first render's
  // empty memo would lock the ref to "seeded" and miss the real arrival.
  // (No-op-on-empty-dialog isn't a concern: this dialog only opens when a
  // host has selected ≥1 candidate to add, so a permanently-empty candidate
  // set isn't a real flow.)
  //
  // The latent bug the rule was pointing at is now fixed by the seededRef
  // guards. react-doctor's pattern-matcher still flags the shape (setState
  // on a prop-derived value inside an effect with that prop in deps) — it
  // can't see that the guard makes the re-fire a no-op. So the disable
  // stays, but the rationale is fundamentally different from the inline-
  // disable in PR #2530: there it claimed FP-should-allow; here it
  // acknowledges "rule shape-matches a fixed bug."
  const seededHumansRef = useRef(false);
  const seededAgentsRef = useRef(false);

  useEffect(() => {
    if (seededHumansRef.current || candidateHumans.length === 0) return;
    seededHumansRef.current = true;
    // oxlint-disable-next-line react-doctor/no-derived-state -- seed-once guard above makes this safe; rule pattern-matches shape but can't see the guard
    setSelectedHumanIds(new Set(candidateHumans.map((m) => m.userId)));
  }, [candidateHumans]);

  useEffect(() => {
    if (seededAgentsRef.current || candidateAgents.length === 0) return;
    seededAgentsRef.current = true;
    // oxlint-disable-next-line react-doctor/no-derived-state -- seed-once guard above makes this safe; rule pattern-matches shape but can't see the guard
    setSelectedAgentIds(new Set(candidateAgents.map((a) => a.id)));
  }, [candidateAgents]);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The picker value is every selected id (agents, then humans). This list
  // only ever trims, so a change keeps whichever ids are still present.
  const selectedIds = useMemo(
    () => [...selectedAgentIds, ...selectedHumanIds],
    [selectedAgentIds, selectedHumanIds],
  );
  const candidates = useMemo(
    () => [...candidateAgents.map(agentCandidate), ...candidateHumans.map(serverMemberCandidate)],
    [candidateAgents, candidateHumans],
  );
  const handleSelectionChange = useCallback((next: string[]) => {
    const kept = new Set(next);
    const keep = (prev: Set<string>) => new Set([...prev].filter((id) => kept.has(id)));
    setSelectedHumanIds(keep);
    setSelectedAgentIds(keep);
  }, []);
  const removeLabel = useCallback(
    (name: string) => formatMessage({ id: "channel.addMembers.removeFromList" }, { name }),
    [formatMessage],
  );

  const nothingToAdd = candidateHumans.length === 0 && candidateAgents.length === 0;
  const nothingSelected = selectedHumanIds.size === 0 && selectedAgentIds.size === 0;
  const canSubmit = !submitting && !nothingToAdd && !nothingSelected;

  const handleSubmit = useCallback(async () => {
    if (!canSubmit || !channel) return;
    setSubmitting(true);
    setError(null);
    // Funnel hook: dialog-driven `execute_attempt` (action-card flow only).
    onSubmitStart?.();
    const userIds = [...selectedHumanIds];
    const agentIds = [...selectedAgentIds];
    try {
      await addMembers({
        userIds, agentIds,
        ...(actionCardMessageId ? { actionCardMessageId } : {}),
        ...(actionCardConfirmationVersion !== undefined ? { actionCardConfirmationVersion } : {}),
      });
      onSubmitted({
        channelId: channel.id,
        channelName: channel.name,
        // Preserve the action-card contract: a concurrent add that makes a
        // selected row an idempotent already-member still satisfies the action.
        addedHumanIds: userIds,
        addedAgentIds: agentIds,
      });
      onClose();
    } catch (err) {
      setError(
        err instanceof Error && err.message
          ? err.message
          : formatMessage({ id: "channel.addMembers.failed" }),
      );
      onSubmitError?.(err);
    } finally {
      setSubmitting(false);
    }
  }, [
    canSubmit,
    channel,
    onSubmitStart,
    selectedHumanIds,
    selectedAgentIds,
    addMembers,
    actionCardMessageId,
    actionCardConfirmationVersion,
    onSubmitted,
    onClose,
    formatMessage,
    onSubmitError,
  ]);

  // Ensure the dialog reflects the latest channel membership before
  // computing candidate filters — without this, freshly-added members
  // from another tab would still appear as candidates.
  useEffect(() => {
    void loadMembers();
  }, [loadMembers]);

  return (
    <DialogCard title={formatMessage({ id: "channel.addMembers.title" })} onClose={onClose} narrow="sheet">
        {/* The target channel is a place: the neutral channel tile (DS
            ChannelIcon, never coloured) and its name. */}
        <div className="mb-3 flex min-w-0 items-center gap-2 text-callout text-foreground">
          <IconTile size="sm">
            <ChannelIcon channel={channel} type={channel?.type} />
          </IconTile>
          <span className="truncate font-bold">{channel?.name ?? formatMessage({ id: "channel.addMembers.unknownChannel" })}</span>
          <span className="shrink-0 text-foreground-muted">{formatMessage({ id: "channel.addMembers.targetChannelSuffix" })}</span>
        </div>

        {draftHint ? (
          <div className="mb-3 border-l-2 border-line-seam pl-2.5 text-callout text-foreground-muted">
            {draftHint}
          </div>
        ) : null}

        {error ? (
          <Banner intent="warning" className="mb-3">
            {error}
          </Banner>
        ) : null}

        {nothingToAdd ? (
          <Card className="mb-4 p-3 text-callout text-foreground-hint">
            {formatMessage({ id: "channel.addMembers.nothingToAdd" })}
          </Card>
        ) : (
          <MemberPicker
            className="mb-4"
            data-testid="add-members-action-list"
            presentation="removable"
            removeLabel={removeLabel}
            candidates={candidates}
            kinds={MEMBER_KINDS}
            value={selectedIds}
            onChange={handleSelectionChange}
            multiple
          />
        )}

        <DialogCardFooter>
          <Button size="lg"
            variant="ghost"
            type="button"
            onClick={onClose}
            disabled={submitting}
          >
            {formatMessage({ id: "common.confirm.cancel" })}
          </Button>
          <DialogCommit>
            {(inHead) => (
              <Button size={inHead ? "md" : "lg"}
                variant="primary"
                type="button"
                onClick={handleSubmit}
                disabled={!canSubmit}
              >
                {submitting
                  ? formatMessage({ id: "channel.addMembers.adding" })
                  : formatMessage(
                      { id: "channel.addMembers.submit" },
                      { count: selectedHumanIds.size + selectedAgentIds.size },
                    )}
              </Button>
            )}
          </DialogCommit>
        </DialogCardFooter>
    </DialogCard>
  );
}
