import { Input, Textarea, SegmentedControl, SegmentedControlItem, SegmentedControlLabel, Button, Separator, TextLink } from "@botiverse/raft-ui";
import { useCallback, useId, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { useIntl } from "react-intl";
import { formatNameValidationError } from "../../i18n/nameValidation";
import { Hash, Lock } from "lucide-react";
import { isAgentInMemberLists, useAgentStore } from "../../store/agentStore";
import { useChannelStore } from "../../store/channelStore";
import { useServerStore } from "../../store/serverStore";
import { useServerFeatureFlag } from "../../store/serverFeatureFlags";
import { useAuthStore } from "../../store/authStore";
import { openUpgradeDialog } from "../../store/upgradeDialogStore";
import { validateNameReason, PLAN_CONFIG, getEffectiveLimits, EXTERNAL_CHANNELS_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";
import type { ServerPlan } from "@botiverse/raft-shared";
import { useAppNavigate } from "../../hooks/useAppNavigate";
import { useExternalInviteTracker } from "../../analytics/externalInvites";
import type { ExternalInviteEntry } from "../../analytics/externalInvites";
import DialogCard from "../ui/DialogCard";
import { DialogCardFooter, DialogCommit } from "../ui/NarrowDialog";
import Banner from "../ui/Banner";
import AvatarSlot from "../ui/AvatarSlot";
import AppBadge from "../agent/AppBadge";
import FormField from "../ui/FormField";
import { useServerPermissions } from "../../hooks/useServerPermissions";
import { ChannelSlackBridgeField, useChannelSlackBridgeEditor } from "./ChannelSlackBridgeField";
import { ExternalChannelIcon } from "./channelKindIcon";
import { currentExternalSlotContext } from "./externalChannelSlot";
import {
  EXTERNAL_INVITE_MAX_EMAILS,
  NO_EMAILS_PREVIEW,
  previewExternalInvitesForNewChannel,
  sendInvitesAndConnectServers,
  useExternalChannelAvailability,
  useExternalChannelCreateAccess,
  useOwnConnectableServers,
} from "./externalInvites";
import type { ExternalInvitePreview, SendExternalInvitesResult } from "./externalInvites";
import {
  ExternalInviteEmailsField,
  ExternalInviteServersField,
  ExternalInviteSteps,
  externalInviteFailure,
  useExternalInviteEntries,
} from "./ExternalInviteSteps";
import { MemberChoiceList, memberChoiceKey, useMemberChoiceSearch } from "./MemberChoiceList";
import type { MemberChoice } from "./MemberChoiceList";
import { ArchivedNameCollisionBanner } from "./ArchivedNameCollisionBanner";
import { parseArchivedNameCollision } from "./archivedNameCollision";
import type { ArchivedNameCollision } from "./archivedNameCollision";

type Visibility = "public" | "private" | "external";

/**
 * With external_channels_v1 on: step 1 names the channel and picks its
 * visibility; step 2 adds people to it (design v5.0 E1, v4.9#1). For an
 * External channel, step 2 also offers "Your servers" (the viewer's other
 * servers they own or administer, as checkboxes: connected on confirm, no
 * email, no approval); its Create and Invite checks the emails first and
 * shows the review (`invite`); the channel is created, private, only when
 * the review is confirmed, so leaving the review creates nothing. Once it is
 * created the invite steps go on for that channel, whatever happens to the
 * invites.
 */
type Step = "details" | "people" | "invite";

interface PrefillProps {
  /** Prefilled values from an action card (per #proj-approval msg=40cb9342). */
  prefilledName?: string;
  prefilledDescription?: string;
  /**
   * The visibility chosen on open. "external" is the sidebar External
   * section's entry; for a viewer without External (useExternalChannelCreateAccess)
   * it falls back to Private, as a choice that stops being available does.
   */
  prefilledVisibility?: Visibility;
  /** With `prefilledVisibility` "external": what opened it (product events: `external_invite_opened.entry`). */
  inviteEntry?: ExternalInviteEntry;
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
  actionCardMessageId?: string;
  actionCardConfirmationVersion?: number;
}

export default function CreateChannelDialog({
  onClose: closeDialog,
  prefilledName,
  prefilledDescription,
  prefilledVisibility,
  inviteEntry,
  prefilledAgentIds,
  prefilledHumanIds,
  stayOnCreate = false,
  onCreated,
  onSubmitStart,
  onSubmitError,
  actionCardMessageId,
  actionCardConfirmationVersion,
}: {
  onClose: () => void;
} & PrefillProps) {
  const { formatMessage } = useIntl();
  const [name, setName] = useState(prefilledName ?? "");
  const [description, setDescription] = useState(prefilledDescription ?? "");
  const [memberSearch, setMemberSearch] = useState("");
  const [visibility, setVisibility] = useState<Visibility>(prefilledVisibility ?? "public");
  const [step, setStep] = useState<Step>("details");
  const [emailText, setEmailText] = useState("");
  // "Your servers" checked on step 2 (External only), carried into the review.
  const [externalServerIds, setExternalServerIds] = useState<string[]>([]);
  // The External review (before anything is created), and the channel once its Create and Invite made it.
  const [externalReview, setExternalReview] = useState<ExternalInvitePreview | null>(null);
  const [createdExternal, setCreatedExternal] = useState<{ id: string; name: string } | null>(null);
  const createdExternalRef = useRef<{ id: string; name: string } | null>(null);
  // The review's Create and Invite while it runs (the dialog can't be closed
  // then), and whether the dialog has closed (nothing after that navigates).
  const externalCommitInFlightRef = useRef(false);
  const externalClosedRef = useRef(false);
  const [selectedAgentIds, setSelectedAgentIds] = useState<Set<string>>(new Set(prefilledAgentIds ?? []));
  const [selectedHumanIds, setSelectedHumanIds] = useState<Set<string>>(new Set(prefilledHumanIds ?? []));
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [archivedCollision, setArchivedCollision] = useState<ArchivedNameCollision | null>(null);
  const [createdChannelForBridge, setCreatedChannelForBridge] = useState<{ id: string; name: string } | null>(null);
  const submitInFlightRef = useRef(false);
  const allAgents = useAgentStore((s) => s.agents);
  const members = useServerStore((s) => s.members);
  const currentUser = useAuthStore((s) => s.user);
  const createChannel = useChannelStore((s) => s.createChannel);
  const channels = useChannelStore((s) => s.channels);
  const nav = useAppNavigate();
  // The External flow's product events: opened here when the dialog opens
  // with External chosen, else the first time External is picked; every close
  // while External is still chosen says which step it was on (the invite steps say their own).
  const tracker = useExternalInviteTracker("create_channel", prefilledVisibility === "external" ? inviteEntry : undefined);
  const onClose = useCallback(() => {
    if (visibility === "external") tracker.closed(step === "invite" ? undefined : step);
    closeDialog();
  }, [closeDialog, step, tracker, visibility]);
  const openBillingSettings = useCallback(() => {
    onClose();
    nav.toSettings("billing");
  }, [nav, onClose]);
  const openExternalUpgrade = useCallback(() => {
    onClose();
    openUpgradeDialog("external_channel_free_limit", { surface: "create_channel", externalContext: currentExternalSlotContext() });
  }, [onClose]);
  const { capabilities } = useServerPermissions();
  // external_channels_v1 off: the one-step dialog as it was, members and
  // Create on the first screen (plan §2a: a flag-off Server sees no change).
  // On: two steps for every visibility, External for owners and admins.
  const twoStep = useServerFeatureFlag(EXTERNAL_CHANNELS_FEATURE_FLAG_KEY).enabled;
  const externalAvailable = useExternalChannelCreateAccess();
  // A Free server whose one external channel is taken: External can still
  // be selected, and then says so in place of its hint, with the upgrade,
  // and Next waits (c_a668d39c). Until the server answers, External can't
  // be chosen, so it is never offered and then taken back.
  const externalAvailability = useExternalChannelAvailability(externalAvailable);
  const externalFreeLimit = externalAvailable && externalAvailability === "freeLimit";
  const externalLoading = externalAvailable && externalAvailability === "loading";
  const externalChoosable = externalAvailable && externalAvailability === "open";
  const externalHintId = useId();
  // External while it is still being checked is ignored (its readOnly radio
  // already refuses a click or a key; this keeps any other path from selecting it).
  const handleVisibilityChange = useCallback((value: Visibility) => {
    if (value === "external" && !externalChoosable && !externalFreeLimit) return;
    setVisibility(value);
    if (value === "external") tracker.opened("create_channel_visibility");
  }, [externalChoosable, externalFreeLimit, tracker]);
  const serverName = useServerStore((s) => s.current?.name ?? "");
  // External is only offered to owners and admins with external_channels_v1
  // on; if that changes while the dialog is open, the choice falls back to Private.
  const external = visibility === "external" && externalChoosable;
  // External chosen at the free limit: shown selected, with the limit line, and nothing goes on.
  const externalAtLimit = visibility === "external" && externalFreeLimit;
  const chosenVisibility: Visibility = visibility === "external" && !externalChoosable && !externalAtLimit ? "private" : visibility;
  const { entries: emailEntries, overBy: emailsOverBy } = useExternalInviteEntries(emailText);
  const ownServers = useOwnConnectableServers(external);
  // Checked and still offered: what step 2's Create and Invite takes.
  const chosenServerIds = useMemo(
    () => ownServers.filter((server) => externalServerIds.includes(server.id)).map((server) => server.id),
    [ownServers, externalServerIds],
  );
  const externalNothingChosen = emailEntries.length === 0 && chosenServerIds.length === 0;
  const bridgeEditor = useChannelSlackBridgeEditor({
    visibility: external ? "private" : visibility === "public" ? "public" : "private",
    canManage: capabilities.createChannels,
  });

  const plan = (useServerStore((s) => s.current?.plan) || "free") as ServerPlan;
  const maxChannels = getEffectiveLimits(plan).maxChannels;
  const atLimit = maxChannels !== -1 && channels.length >= maxChannels;

  // Agents, then people: the same fields the people search ranks on (MemberChoiceList).
  const memberChoices = useMemo<MemberChoice<unknown>[]>(() => [
      ...allAgents.filter(isAgentInMemberLists).map((agent) => ({
        kind: "agent" as const,
        id: agent.id,
        value: agent,
        handle: agent.name,
        displayName: agent.displayName,
        description: agent.description,
        media: <AvatarSlot context="sidebar-list" type="agent" agentAvatarUrl={agent.avatarUrl} />,
        badge: agent.managedByAppInstallId
          ? <AppBadge className="shrink-0" appName={agent.managedByApp?.name} botName={agent.displayName || agent.name} />
          : undefined,
      })),
      ...members.filter((member) => member.userId !== currentUser?.id).map((member) => ({
        kind: "human" as const,
        id: member.userId,
        value: member,
        handle: member.name,
        displayName: member.displayName,
        description: member.description,
        sourceServerLabel: member.serverName || member.serverSlug,
        media: <AvatarSlot context="sidebar-list" type="human" humanPlaceholder />,
      })),
    ], [allAgents, currentUser?.id, members]);
  const memberMatches = useMemberChoiceSearch(memberSearch, memberChoices);
  const selectedMemberKeys = useMemo(() => [
    ...[...selectedAgentIds].map((id) => memberChoiceKey("agent", id)),
    ...[...selectedHumanIds].map((id) => memberChoiceKey("human", id)),
  ], [selectedAgentIds, selectedHumanIds]);
  const handleMembersChange = useCallback((keys: string[]) => {
    const pick = (kind: "agent" | "human") => new Set(keys.filter((key) => key.startsWith(`${kind}:`)).map((key) => key.slice(kind.length + 1)));
    setSelectedAgentIds(pick("agent"));
    setSelectedHumanIds(pick("human"));
  }, []);
  const memberGroupLabels = useMemo(() => ({
    agent: formatMessage({ id: "channel.create.agents" }),
    human: formatMessage({ id: "channel.create.humans" }),
  }), [formatMessage]);

  const nameError = useCallback(() => formatNameValidationError(
    validateNameReason(name),
    "channel.create.nameFieldName",
    formatMessage,
  ), [formatMessage, name]);

  // Step 1's Next: the name is checked here so step 2 only creates.
  const handleNext = useCallback((e: FormEvent) => {
    e.preventDefault();
    if (atLimit || externalAtLimit) return;
    setError("");
    setArchivedCollision(null);
    const reason = nameError();
    if (reason) {
      setError(reason);
      return;
    }
    setStep("people");
  }, [atLimit, externalAtLimit, nameError]);

  const handleBackToDetails = useCallback(() => {
    setError("");
    setStep("details");
  }, []);

  const finish = useCallback((channel: { id: string; name: string }) => {
    onClose();
    if (!stayOnCreate) {
      nav.toChannel(channel.id);
    }
  }, [nav, onClose, stayOnCreate]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (submitInFlightRef.current) return;
    if (external && (externalNothingChosen || emailsOverBy > 0)) return;
    setError("");
    setArchivedCollision(null);
    const reason = nameError();
    if (reason) {
      setError(reason);
      setStep("details");
      return;
    }
    submitInFlightRef.current = true;
    setSubmitting(true);
    if (external) {
      // The review first (design E1): nothing is created until it is confirmed.
      try {
        // Only servers: nothing to classify.
        const review = emailEntries.length === 0 ? NO_EMAILS_PREVIEW : await previewExternalInvitesForNewChannel(emailEntries);
        setExternalReview(review);
        setStep("invite");
        // Step 2 has neither warning: a new channel has no earlier messages and is created private.
        tracker.reviewed({
          emails: review.valid.length + review.alreadyMembers.length,
          servers: chosenServerIds.length,
          historyWarningShown: false,
          becomesPrivate: false,
        });
      } catch (err) {
        setError(formatMessage({ id: externalInviteFailure(err).id }, { max: EXTERNAL_INVITE_MAX_EMAILS }));
      } finally {
        submitInFlightRef.current = false;
        setSubmitting(false);
      }
      return;
    }
    // Funnel hook: dialog-driven `execute_attempt` (action-card flow only).
    onSubmitStart?.();
    try {
      const channel = createdChannelForBridge ?? await createChannel(
          name.trim(),
          description.trim() || undefined,
          {
            visibility: chosenVisibility === "public" ? "public" : "private",
            agentIds: [...selectedAgentIds],
            userIds: [...selectedHumanIds],
            actionCardMessageId,
            actionCardConfirmationVersion,
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
      finish(channel);
    } catch (err: unknown) {
      handleCreateError(err);
    } finally {
      submitInFlightRef.current = false;
      setSubmitting(false);
    }
  };

  // A refused create: an archived-name collision goes back to step 1, where
  // the name is; anything else is said on step 2.
  const handleCreateError = useCallback((err: unknown) => {
    const collision = parseArchivedNameCollision(err, ["channel", "private"]);
    if (collision) {
      setArchivedCollision(collision);
      // The name is on step 1: go back there to change it or unarchive.
      setStep("details");
    } else {
      const axiosErr = err as { response?: { data?: { error?: string } } };
      setError(axiosErr.response?.data?.error || formatMessage({ id: "channel.create.failedCreate" }));
      if (step === "invite") setStep("people");
    }
    // Funnel hook: dialog-driven `execute_fail`. Fired for both archived-
    // collision and generic errors — both are the same product event
    // ("user submitted, server rejected"). Caller classifies.
    onSubmitError?.(err);
  }, [formatMessage, onSubmitError, step]);

  // The External review's Create and Invite: the channel is created (private,
  // plan §5) only now, then the reviewed addresses are sent to it. A send
  // that fails after the create leaves the channel, and a retry sends again
  // to it rather than creating another.
  const commitExternal = useCallback(async (addresses: string[], serverIds: string[]): Promise<SendExternalInvitesResult> => {
    externalCommitInFlightRef.current = true;
    try {
      let channel = createdExternalRef.current;
      if (!channel) {
        onSubmitStart?.();
        try {
          const created = await createChannel(name.trim(), description.trim() || undefined, {
            visibility: "private",
            agentIds: [...selectedAgentIds],
            userIds: [...selectedHumanIds],
            actionCardMessageId,
            actionCardConfirmationVersion,
          });
          channel = { id: created.id, name: created.name };
        } catch (err) {
          setError("");
          setArchivedCollision(null);
          handleCreateError(err);
          throw err;
        }
        createdExternalRef.current = channel;
        setCreatedExternal(channel);
        onCreated?.(channel);
      }
      return await sendInvitesAndConnectServers(channel.id, addresses, serverIds, false);
    } finally {
      externalCommitInFlightRef.current = false;
    }
  }, [
    actionCardConfirmationVersion, actionCardMessageId, createChannel, description, handleCreateError, name,
    onCreated, onSubmitStart, selectedAgentIds, selectedHumanIds,
  ]);

  const handleChangeCollidingName = useCallback(() => {
    setArchivedCollision(null);
    setName("");
  }, []);
  const handleNameChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => setName(e.target.value), []);
  const handleDescriptionChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => setDescription(e.target.value),
    [],
  );

  // Leaving the External review: before the create, nothing was made and the
  // dialog just closes; after it, to the channel.
  // While Create and Invite runs it can't be closed (× and Esc do nothing, as
  // Back is disabled): the channel may be being made. Once closed, a late
  // answer neither closes nor navigates again.
  const closeExternalReview = useCallback(() => {
    if (externalCommitInFlightRef.current || externalClosedRef.current) return;
    externalClosedRef.current = true;
    const created = createdExternalRef.current;
    if (created) finish(created);
    else onClose();
  }, [finish, onClose]);
  const backToPeople = useCallback(() => {
    setError("");
    setStep("people");
  }, []);

  if (step === "invite" && externalReview) {
    // Same dialog card, so the modal stays put. Back returns to step 2 until
    // the channel exists; from then on the invite steps are that channel's.
    return (
      <DialogCard
        title={formatMessage({ id: "channel.externalInvite.title" }, { server: serverName })}
        onClose={closeExternalReview}
        narrow="sheet"
        testId="create-channel-dialog"
      >
        <ExternalInviteSteps
          channelId={createdExternal?.id ?? null}
          serverName={serverName}
          willBecomePrivate={false}
          dismissLabel={formatMessage({ id: "channel.create.externalSkip" })}
          onDismiss={closeExternalReview}
          onSent={closeExternalReview}
          initialText={emailText}
          initialPreview={externalReview}
          servers={ownServers}
          initialServerIds={chosenServerIds}
          channelName={createdExternal?.name ?? name.trim()}
          commit={commitExternal}
          commitLabel={createdExternal ? undefined : "channel.create.externalSubmit"}
          onBackFromReview={createdExternal ? undefined : backToPeople}
          upgradeSurface="create_channel"
          tracker={tracker}
          notice={createdExternal ? (
            <Banner intent="success" data-testid="create-channel-external-created">
              {formatMessage({ id: "channel.create.externalCreated" }, { name: createdExternal.name })}
            </Banner>
          ) : undefined}
        />
      </DialogCard>
    );
  }

  const errorBanner = error && !atLimit && (
    <Banner intent="warning" data-testid="create-channel-error">
      {error}
    </Banner>
  );

  // External's step 2: the people added from this server, beside those invited from outside it.
  const membersLabel = external
    ? formatMessage({ id: "channel.create.externalMembersLabel" }, { server: serverName })
    : formatMessage({ id: "channel.create.membersLabel" });
  const membersField = (
    <FormField label={membersLabel} optional>
      <MemberChoiceList
        choices={memberChoices}
        value={selectedMemberKeys}
        onValueChange={handleMembersChange}
        query={memberSearch}
        onQueryChange={setMemberSearch}
        matchedValues={memberMatches}
        ariaLabel={membersLabel}
        groupLabels={memberGroupLabels}
        searchLabel={formatMessage({ id: "channel.create.membersSearchPlaceholder" })}
        clearSearchLabel={formatMessage({ id: "search.clearSearch" })}
        noMatchLabel={formatMessage({ id: "channel.create.noMatchesFor" }, { query: memberSearch.trim() })}
        empty={formatMessage({ id: "channel.create.noMembersAvailable" })}
      />
    </FormField>
  );

  if (step === "people") {
    const emailsBlocked = external && (externalNothingChosen || emailsOverBy > 0);
    return (
      <DialogCard
        title={formatMessage({ id: "channel.create.peopleTitle" }, { name: name.trim() })}
        onClose={onClose}
        narrow="sheet"
        testId="create-channel-dialog"
      >
        <form onSubmit={handleSubmit} className="stack-y-4 md:pointer-fine:stack-y-3" data-testid="create-channel-people">
          {errorBanner}
          {external && (
            <ExternalInviteEmailsField value={emailText} onChange={setEmailText} overBy={emailsOverBy} autoFocus />
          )}
          {external && (
            <ExternalInviteServersField servers={ownServers} value={externalServerIds} onChange={setExternalServerIds} disabled={submitting} />
          )}
          {membersField}
          {/* Back keeps everything filled in on both steps (v4.9#1); once a
              bridge failed after the create, the channel exists and the
              visibility can no longer change. */}
          <DialogCardFooter>
            <Button size="lg"
              variant="ghost"
              type="button"
              onClick={handleBackToDetails}
              disabled={submitting || !!createdChannelForBridge}
              data-testid="create-channel-back"
            >
              {formatMessage({ id: "channel.externalInvite.dialog.back" })}
            </Button>
            <DialogCommit>
              {(inHead) => (
                <Button size={inHead ? "md" : "lg"}
                  variant="primary"
                  type="submit"
                  disabled={atLimit || emailsBlocked}
                  loading={submitting}
                  loadingLabel={formatMessage({ id: "channel.create.creating" })}
                  data-testid="create-channel-submit"
                >
                  {formatMessage({ id: external ? "channel.create.externalSubmit" : "channel.create.submit" })}
                </Button>
              )}
            </DialogCommit>
          </DialogCardFooter>
        </form>
      </DialogCard>
    );
  }

  return (
    <DialogCard title={formatMessage({ id: "channel.create.title" })} onClose={onClose} narrow="sheet" testId="create-channel-dialog">
        <form onSubmit={twoStep ? handleNext : handleSubmit} className="stack-y-4 md:pointer-fine:stack-y-3" data-testid="create-channel-details">
          {atLimit && (
            <Banner intent="warning">
              {formatMessage(
                { id: "channel.create.limitReached" },
                { used: channels.length, max: maxChannels, plan: PLAN_CONFIG[plan].displayName },
              )}{" "}
              <TextLink
                variant="strong"
                onClick={openBillingSettings}
              >
                {formatMessage({ id: "channel.create.upgradeForMore" })}
              </TextLink>
            </Banner>
          )}
          {errorBanner}
          <ArchivedNameCollisionBanner
            collision={archivedCollision}
            onLeave={onClose}
            onError={setError}
            onChangeName={handleChangeCollidingName}
          />
          <FormField label={formatMessage({ id: "channel.create.nameLabel" })} required>
            <Input
              type="text"
              value={name}
              onChange={handleNameChange}
              className="w-full"
              placeholder={formatMessage({ id: "channel.create.namePlaceholder" })}
              required
              autoFocus
            />
          </FormField>
          <FormField label={formatMessage({ id: "channel.create.descriptionLabel" })} optional>
            <Textarea
              value={description}
              onChange={handleDescriptionChange}
              className="w-full"
              placeholder={formatMessage({ id: "channel.create.descriptionPlaceholder" })}
              rows={2}
            />
          </FormField>
          <FormField
            label={formatMessage({ id: "channel.create.visibilityLabel" })}
            hint={external ? formatMessage({ id: "channel.create.externalHint" }, { server: serverName }) : externalAtLimit ? (
              <span id={externalHintId} data-testid="create-channel-external-free-limit">
                {formatMessage({ id: "channel.create.externalFreeLimit" }, { server: serverName })}{" "}
                <TextLink variant="strong" onClick={openExternalUpgrade}>
                  {formatMessage({ id: "channel.create.upgradeForMore" })}
                </TextLink>
              </span>
            ) : undefined}
          >
            <SegmentedControl
              value={chosenVisibility}
              onValueChange={handleVisibilityChange}
              aria-label={formatMessage({ id: "channel.create.visibilityAriaLabel" })}
            >
              <SegmentedControlItem value="public">
                <Hash size={16} aria-hidden="true" />
                <SegmentedControlLabel>{formatMessage({ id: "channel.create.public" })}</SegmentedControlLabel>
              </SegmentedControlItem>
              <SegmentedControlItem value="private">
                <Lock size={16} aria-hidden="true" />
                <SegmentedControlLabel>{formatMessage({ id: "channel.create.private" })}</SegmentedControlLabel>
              </SegmentedControlItem>
              {externalAvailable && (
                // Not known yet: focusable and announced as unavailable, never
                // selected (raft-ui's item passes Base UI's readOnly through;
                // native `disabled` would drop it from the arrow keys). At the
                // free limit it can be selected, and the limit line is its description.
                <SegmentedControlItem
                  value="external"
                  readOnly={externalLoading}
                  aria-disabled={externalLoading ? true : undefined}
                  aria-describedby={externalAtLimit ? externalHintId : undefined}
                  data-testid="create-channel-external"
                >
                  <ExternalChannelIcon size={16} />
                  <SegmentedControlLabel>{formatMessage({ id: "channel.create.external" })}</SegmentedControlLabel>
                </SegmentedControlItem>
              )}
            </SegmentedControl>
          </FormField>
          {!twoStep && membersField}
          {bridgeEditor.available && !external && (
            <div>
              <Separator />
              <ChannelSlackBridgeField editor={bridgeEditor} visibility={chosenVisibility === "public" ? "public" : "private"} disabled={submitting || !!createdChannelForBridge} className="pb-0" />
            </div>
          )}
          {/* DS Dialog actions: Cancel is ghost on the left, the one pink
              button on the right: Next with two steps, else Create Channel. */}
          <DialogCardFooter>
            <Button size="lg"
              variant="ghost"
              type="button"
              onClick={onClose}
              disabled={submitting}
            >
              {formatMessage({ id: "settings.common.cancel" })}
            </Button>
            <DialogCommit>
              {(inHead) => (twoStep ? (
                <Button size={inHead ? "md" : "lg"}
                  variant="primary"
                  type="submit"
                  // External asked for (the sidebar's entry) and still being checked: wait for the answer.
                  disabled={atLimit || (externalLoading && visibility === "external") || externalAtLimit}
                  data-testid="create-channel-next"
                >
                  {formatMessage({ id: "channel.externalInvite.dialog.next" })}
                </Button>
              ) : (
                <Button size={inHead ? "md" : "lg"}
                  variant="primary"
                  type="submit"
                  disabled={atLimit || submitting}
                >
                  {submitting ? formatMessage({ id: "channel.create.creating" }) : formatMessage({ id: "channel.create.submit" })}
                </Button>
              ))}
            </DialogCommit>
          </DialogCardFooter>
        </form>
    </DialogCard>
  );
}
