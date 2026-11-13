import { Input, Textarea, Button, TextLink } from "@botiverse/raft-ui";
import { useCallback, useMemo, useRef, useState } from "react";
import { GitBranch, Plus } from "lucide-react";
import { MAX_JOINT_CHANNEL_SERVERS, validateNameReason } from "@botiverse/raft-shared";
import { useIntl } from "react-intl";
import type { IntlShape } from "react-intl";
import { formatNameValidationError } from "../../i18n/nameValidation";
import { isAgentInMemberLists, useAgentStore } from "../../store/agentStore";
import { useAuthStore } from "../../store/authStore";
import { useChannelStore } from "../../store/channelStore";
import { useServerStore } from "../../store/serverStore";
import { useAppNavigate } from "../../hooks/useAppNavigate";
import { usePaywallUpgrade } from "../../hooks/usePaywallUpgrade";
import { isPaywallGate, PaywallShown } from "../../analytics/paywall";
import type { UpgradeGate } from "../../store/upgradeDialogStore";
import AvatarSlot from "../ui/AvatarSlot";
import AppBadge from "../agent/AppBadge";
import Banner from "../ui/Banner";
import FormField from "../ui/FormField";
import SectionEyebrow from "../ui/SectionEyebrow";
import DialogCard from "../ui/DialogCard";
import { formatJointInviteRateLimited, jointFreeHostLimitMessage } from "../../utils/jointChannelLimit";
import { JointInviteDraftCard } from "./JointInviteDraftCard";
import { MemberChoiceList, memberChoiceKey, useMemberChoiceSearch } from "./MemberChoiceList";
import type { MemberChoice } from "./MemberChoiceList";
import { findSameAdminJointTarget, parseInvitedPeopleText } from "../../utils/jointSameAdmin";
import { DialogCardFooter, DialogCommit } from "../ui/NarrowDialog";
import { ArchivedNameCollisionBanner } from "./ArchivedNameCollisionBanner";
import { parseArchivedNameCollision } from "./archivedNameCollision";
import type { ArchivedNameCollision } from "./archivedNameCollision";

export interface JointInviteDraft {
  id: string;
  targetServerSlug: string;
  invitedPeopleText: string;
  /** The inviter confirmed connecting directly as admin of both servers. */
  sameAdminConfirmed?: boolean;
}

function isBillingGateError(error: string) {
  return error.includes("requires the Pro plan");
}

export type JointInviteDraftUpdate = Partial<Omit<JointInviteDraft, "id">>;

export default function CreateJointChannelDialog({ onClose }: { onClose: () => void }) {
  const { formatMessage } = useIntl();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [jointInviteDrafts, setJointInviteDrafts] = useState<JointInviteDraft[]>([
    { id: "invite-1", targetServerSlug: "", invitedPeopleText: "" },
  ]);
  const [memberSearch, setMemberSearch] = useState("");
  const [selectedAgentIds, setSelectedAgentIds] = useState<Set<string>>(new Set());
  const [selectedHumanIds, setSelectedHumanIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");
  /** The Free limit the server answered with, if any: its Upgrade opens the upgrade dialog. */
  const [billingError, setBillingError] = useState<UpgradeGate | null>(null);
  const [archivedCollision, setArchivedCollision] = useState<ArchivedNameCollision | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const submitInFlightRef = useRef(false);
  const nextInviteIdRef = useRef(2);
  const createChannel = useChannelStore((s) => s.createChannel);
  const allAgents = useAgentStore((s) => s.agents);
  const members = useServerStore((s) => s.members);
  const plan = useServerStore((s) => s.current?.plan) || "free";
  const currentServerSlug = useServerStore((s) => s.current?.slug ?? null);
  const currentServerName = useServerStore((s) => s.current?.name ?? "");
  const servers = useServerStore((s) => s.servers);
  const currentUser = useAuthStore((s) => s.user);
  const nav = useAppNavigate();
  const paywallUpgrade = usePaywallUpgrade();
  const openUpgrade = useCallback(() => {
    if (!billingError) return;
    onClose();
    paywallUpgrade(billingError);
  }, [billingError, onClose, paywallUpgrade]);

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
  // RFC 075 §4.5: per draft, the server the inviter administers when they are
  // inviting themselves there; the draft then needs an explicit confirmation.
  const sameAdminTargets = useMemo(() => new Map(jointInviteDrafts.map((draft) => [
    draft.id,
    findSameAdminJointTarget({
      servers,
      currentServerSlug,
      user: currentUser,
      targetServerSlug: draft.targetServerSlug,
      invitedPeople: parseInvitedPeopleText(draft.invitedPeopleText),
    }),
  ])), [currentServerSlug, currentUser, jointInviteDrafts, servers]);
  const maxJointInviteDrafts = MAX_JOINT_CHANNEL_SERVERS - 1;
  const canAddJointInviteDraft = jointInviteDrafts.length < maxJointInviteDrafts;

  // A submit error is about the invite list it was submitted with (e.g. the
  // free-server limit). Once that list changes, the error no longer describes
  // it, so clear it rather than leave a stale reason on screen.
  const clearSubmitError = useCallback(() => {
    setError("");
    setBillingError(null);
  }, []);

  const updateJointInviteDraft = useCallback((id: string, updates: JointInviteDraftUpdate) => {
    clearSubmitError();
    setJointInviteDrafts((prev) => prev.map((draft) => draft.id === id ? { ...draft, ...updates } : draft));
  }, [clearSubmitError]);

  const addJointInviteDraft = useCallback(() => {
    if (!canAddJointInviteDraft) return;
    clearSubmitError();
    const id = `invite-${nextInviteIdRef.current++}`;
    setJointInviteDrafts((prev) => [...prev, { id, targetServerSlug: "", invitedPeopleText: "" }]);
  }, [canAddJointInviteDraft, clearSubmitError]);

  const removeJointInviteDraft = useCallback((id: string) => {
    clearSubmitError();
    setJointInviteDrafts((prev) => prev.length > 1 ? prev.filter((draft) => draft.id !== id) : prev);
  }, [clearSubmitError]);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (submitInFlightRef.current) return;
    setError("");
    setBillingError(null);
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
    const jointInvites = jointInviteDrafts.map((draft) => ({
      targetServerSlug: draft.targetServerSlug.trim(),
      invitedPeople: parseInvitedPeopleText(draft.invitedPeopleText),
      ...(sameAdminTargets.get(draft.id) ? { sameAdmin: true } : {}),
    }));
    const incompleteInvite = jointInvites.find((invite) => !invite.targetServerSlug || invite.invitedPeople.length === 0);
    if (incompleteInvite?.targetServerSlug === "") {
      setError(formatMessage({ id: "channel.edit.inviteSlugRequired" }));
      return;
    }
    if (incompleteInvite) {
      setError(formatMessage({ id: "channel.edit.inviteePersonRequired" }));
      return;
    }
    if (jointInviteDrafts.some((draft) => sameAdminTargets.get(draft.id) && !draft.sameAdminConfirmed)) {
      setError(formatMessage({ id: "channel.jointInvite.sameAdmin.confirmRequired" }));
      return;
    }

    submitInFlightRef.current = true;
    setSubmitting(true);
    try {
      const channel = await createChannel(name.trim(), description.trim() || undefined, {
        visibility: "joint",
        agentIds: [...selectedAgentIds],
        userIds: [...selectedHumanIds],
        jointInvites,
      });
      onClose();
      nav.toChannel(channel.id);
    } catch (err: unknown) {
      const axiosErr = err as {
        response?: {
          data?: {
            error?: string;
            code?: string;
            targetServerSlug?: string;
            invitee?: string;
            retryAfterSeconds?: number;
          };
        };
      };
      const body = axiosErr.response?.data;
      const inviteError = describeJointInviteError(body, currentServerSlug, formatMessage);
      const collision = parseArchivedNameCollision(err, ["joint"]);
      if (collision) {
        setArchivedCollision(collision);
      } else if (body?.code === "joint_channel_free_limit_reached" || body?.code === "joint_channel_plan_limit_reached") {
        setError(jointFreeHostLimitMessage(err, formatMessage) ?? "");
        setBillingError(body?.code === "joint_channel_free_limit_reached" ? "joint_channel_host_limit" : null);
      } else if (body?.code === "joint_free_server_limit") {
        setError(formatMessage({ id: "channel.joint.freeServerLimit" }));
        setBillingError("joint_channel_free_cap");
      } else if (body?.code === "joint_server_limit") {
        setError(formatMessage({ id: "channel.joint.serverLimit" }, { max: MAX_JOINT_CHANNEL_SERVERS }));
      } else if (inviteError) {
        setError(inviteError);
      } else {
        const nextError = body?.error || formatMessage({ id: "channel.createJoint.failedCreate" });
        setError(nextError);
        setBillingError(isBillingGateError(nextError) ? "joint_channel_host_limit" : null);
      }
    } finally {
      submitInFlightRef.current = false;
      setSubmitting(false);
    }
  };

  const handleChangeCollidingName = useCallback(() => {
    setArchivedCollision(null);
    setName("");
  }, []);
  const handleNameChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => setName(event.target.value),
    [],
  );
  const handleDescriptionChange = useCallback(
    (event: React.ChangeEvent<HTMLTextAreaElement>) => setDescription(event.target.value),
    [],
  );

  return (
    <DialogCard
      title={(
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate">{formatMessage({ id: "channel.createJoint.title" })}</span>
        </span>
      )}
      onClose={onClose}
      maxWidthClass="max-w-lg"
      narrow="sheet"
    >
        <form onSubmit={handleSubmit} className="stack-y-4 md:pointer-fine:stack-y-3">
          {error && (
            <Banner intent="warning">
              {error}
              {billingError && (
                <>
                  {" "}
                  {isPaywallGate(billingError) ? <PaywallShown gate={billingError} /> : null}
                  <TextLink
                    variant="strong"
                    onClick={openUpgrade}
                    data-testid="create-joint-upgrade"
                  >
                    {formatMessage({ id: plan === "free" ? "billing.upgradeToPro" : "channel.createJoint.viewBilling" })}
                  </TextLink>
                </>
              )}
            </Banner>
          )}
          <ArchivedNameCollisionBanner
            collision={archivedCollision}
            onLeave={onClose}
            onError={setError}
            onChangeName={handleChangeCollidingName}
            showHint={false}
          />

          <FormField label={formatMessage({ id: "channel.create.nameLabel" })} required>
            <Input
              type="text"
              value={name}
              onChange={handleNameChange}
              className="w-full"
              placeholder={formatMessage({ id: "channel.createJoint.namePlaceholder" })}
              required
              autoFocus
            />
          </FormField>

          <FormField label={formatMessage({ id: "channel.create.descriptionLabel" })} optional>
            <Textarea
              value={description}
              onChange={handleDescriptionChange}
              className="w-full"
              placeholder={formatMessage({ id: "channel.createJoint.descriptionPlaceholder" })}
              rows={2}
            />
          </FormField>

          {/* The invites are one section of the form: a 13/18 700 ink-2 heading
              with its add action, then one inset card per server. */}
          <section className="stack-y-3">
            <div className="flex items-center justify-between gap-3">
              <SectionEyebrow as="div" tone="muted" className="flex items-center gap-2">
                <GitBranch size={16} aria-hidden="true" />
                {formatMessage({ id: "channel.createJoint.inviteServersSection" })}
              </SectionEyebrow>
              <Button size="md"
                variant="outline"
                type="button"
                onClick={addJointInviteDraft}
                disabled={submitting || !canAddJointInviteDraft}
              >
                <Plus size={16} aria-hidden="true" />
                {formatMessage({ id: "channel.createJoint.addServer" })}
              </Button>
            </div>
            {/* Only at the cap, as in EditChannelDialog: it explains why "Add server" is disabled. */}
            {!canAddJointInviteDraft && (
              <p className="text-caption text-foreground-hint" data-testid="create-joint-max-servers-hint">
                {formatMessage(
                  { id: "channel.createJoint.maxServers" },
                  { max: MAX_JOINT_CHANNEL_SERVERS },
                )}
              </p>
            )}
            {jointInviteDrafts.map((draft, index) => (
              <JointInviteDraftCard
                key={draft.id}
                draft={draft}
                index={index}
                canRemove={jointInviteDrafts.length > 1}
                submitting={submitting}
                sameAdminTarget={sameAdminTargets.get(draft.id) ?? null}
                sourceServerName={currentServerName}
                onUpdate={updateJointInviteDraft}
                onRemove={removeJointInviteDraft}
              />
            ))}
          </section>

          <FormField label={formatMessage({ id: "channel.createJoint.currentServerMembers" })} optional>
            <MemberChoiceList
              choices={memberChoices}
              value={selectedMemberKeys}
              onValueChange={handleMembersChange}
              query={memberSearch}
              onQueryChange={setMemberSearch}
              matchedValues={memberMatches}
              ariaLabel={formatMessage({ id: "channel.createJoint.currentServerMembers" })}
              groupLabels={memberGroupLabels}
              searchLabel={formatMessage({ id: "channel.create.membersSearchPlaceholder" })}
              clearSearchLabel={formatMessage({ id: "search.clearSearch" })}
              noMatchLabel={formatMessage({ id: "channel.create.noMatchesFor" }, { query: memberSearch.trim() })}
              empty={formatMessage({ id: "channel.create.noMembersAvailable" })}
            />
          </FormField>

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
              {(inHead) => (
                <Button size={inHead ? "md" : "lg"}
                  variant="primary"
                  type="submit"
                  disabled={submitting}
                >
                  {submitting
                    ? formatMessage({ id: "channel.create.creating" })
                    : formatMessage({ id: "channel.create.submit" })}
                </Button>
              )}
            </DialogCommit>
          </DialogCardFooter>
        </form>
    </DialogCard>
  );
}

/**
 * Localizes the server's typed joint-invite rejections (`sendJointInviteValidationError`,
 * PR #7654). The server's own `error` string is English-only and names the invitee,
 * so showing it verbatim leaves zh users an untranslated sentence. The body carries
 * `targetServerSlug` and, for invitee-scoped codes, `invitee` — the exact person the
 * server rejected. The response's `inviteeIndex` is deliberately not used: it indexes
 * the server's deduplicated invitee list, not the list this dialog submitted.
 *
 * Returns null for anything it cannot describe precisely; the caller then keeps the
 * existing fallback (server text, else the generic failure).
 */
function describeJointInviteError(
  body: { code?: string; targetServerSlug?: string; invitee?: string; retryAfterSeconds?: number } | undefined,
  currentServerSlug: string | null,
  formatMessage: IntlShape["formatMessage"],
): string | null {
  const server = body?.targetServerSlug;
  switch (body?.code) {
    // One code whether nobody matches or the match is not an admin, so the
    // answer does not tell whether an address belongs to that server.
    case "joint_invitee_unavailable": {
      const invitee = body.invitee;
      if (!server || !invitee) return null;
      return formatMessage({ id: "channel.jointInvite.error.inviteeUnavailable" }, { invitee, server });
    }
    case "joint_target_server_invalid":
      // One code, two causes: the server says "Target server not found" or "Cannot
      // invite the current server". Only the slug tells them apart.
      if (server && currentServerSlug && server === currentServerSlug) {
        return formatMessage({ id: "channel.jointInvite.error.cannotInviteSelf" });
      }
      if (!server) return null;
      return formatMessage({ id: "channel.jointInvite.error.serverNotFound" }, { server });
    case "joint_invite_required":
      return formatMessage({ id: "channel.edit.inviteePersonRequired" });
    case "joint_invite_rate_limited":
      return formatJointInviteRateLimited(body.retryAfterSeconds, formatMessage);
    default:
      return null;
  }
}
