import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useIntl } from "react-intl";
import { Check, Copy, Link, Mail, Plus } from "lucide-react";
import { Button, Field, Input, SegmentedControl, SegmentedControlItem, SegmentedControlLabel, Select, SelectContent, SelectIcon, SelectItem, SelectItemIndicator, SelectItemText, SelectList, SelectTrigger, SelectValue, TextLink } from "@botiverse/raft-ui";
import { PRO_AGENT_SEAT_BLOCK_SIZE, formatBillingCapacityLimitMessage, getBillingCapacityLimitState, getBillingUsage, seatTenths, seatsFromTenths, validateEmailAddress } from "@botiverse/raft-shared";
import { useServerStore } from "../../store/serverStore";
import { PRO_SEAT_ADD_FEATURE_FLAG_KEY, useServerFeatureFlag } from "../../store/serverFeatureFlags";
import { useServerPermissions } from "../../hooks/useServerPermissions";
import { useAppNavigate } from "../../hooks/useAppNavigate";
import { PaywallShown, trackPaywallAction } from "../../analytics/paywall";
import { noteBillingEntry } from "../../analytics/billingEntry";
import { trackFeature } from "../../analytics/features";
import api from "../../api/client";
import { shareableWebOrigin } from "../../utils/desktopShell";
import DialogCard from "../ui/DialogCard";
import { DialogCardFooter, DialogCommit } from "../ui/NarrowDialog";
import Tooltip from "../ui/Tooltip";
import Banner from "../ui/Banner";
import type { AddSeatsNeed } from "../billing/AddSeatsDialog";
import { InviteeRow } from "./InviteeRow";
import ConfirmDialog from "../ConfirmDialog";
import { deferredDialog } from "../../boot/deferredUi";

const AddSeatsDialog = deferredDialog(() => import("../billing/AddSeatsDialog"));

// DS TextField label: 13/18 600 ink-2, always visible, sentence case.
const FIELD_LABEL_CLASS = "mb-1.5 block text-footnote font-semibold text-foreground-muted";

/** Where the invite dialog was opened from (`feature_action.surface`). */
export type InviteSurface = "sidebar" | "server_menu" | "members_page";

/**
 * `id` is a stable React key that survives removal of an earlier row. Index
 * keys would reuse a removed row's identity and carry the wrong text into the
 * wrong box.
 */
export interface Invitee {
  id: string;
  email: string;
}

interface JoinLinkRecord {
  id: string;
  token: string;
  maxUses?: number | null;
  expiresAt?: string | null;
  useCount?: number | null;
}

function isBillingGateError(error: string) {
  return error.includes("seat limit") || error.includes("limit reached") || error.includes("requires the Pro plan");
}

export type InviteePatch = Partial<Omit<Invitee, "id">>;

export default function InviteHumanDialog({
  onClose,
  surface,
}: {
  onClose: () => void;
  /** Where the dialog was opened from, for `feature_action` (invite). */
  surface: InviteSurface;
}) {
  const intl = useIntl();
  const { formatMessage } = intl;
  const server = useServerStore((s) => s.current);
  const billing = useServerStore((s) => s.billing);
  const loadBilling = useServerStore((s) => s.loadBilling);
  const nav = useAppNavigate();
  // Once per dialog: the funnel's first step (open → send → someone joins).
  useEffect(() => {
    trackFeature("invite", "open", { surface });
  }, [surface]);
  const openBillingSettings = useCallback(() => {
    onClose();
    trackPaywallAction("seat_limit_invite", "view_billing");
    noteBillingEntry("seat_limit_invite");
    nav.toSettings("billing");
  }, [nav, onClose]);
  /**
   * One row per person. Every invite grants Member: a Guest belongs to exactly
   * one channel and is never created by a server invite (the server refuses
   * `role: "guest"` with 400, #wg-rbac:#15), so there is no role to choose.
   *
   * Starts at one row rather than three empty boxes: rows are addable, so three
   * placeholders only asked a question most inviters do not have.
   */
  const [invitees, setInvitees] = useState<Invitee[]>(() => [{ id: "invitee-0", email: "" }]);
  const nextInviteeId = useRef(1);
  const inviteeFieldId = useId();
  const [joinLink, setJoinLink] = useState<JoinLinkRecord | null>(null);
  const [linkLoading, setLinkLoading] = useState(false);
  // Optional link limits (Phase 1). The selectors are an edit DRAFT, kept
  // separate from the active link. Each is a "keep current" choice so changing
  // ONE never silently drops the other. "keep" resolves against `linkLimits` —
  // a STABLE snapshot of the current link's limits that only updates on a
  // successful (re)generate, NOT when the link is transiently cleared. That is
  // what lets a retry after a failed create resend the SAME chosen limits
  // instead of falling back to unlimited/never.
  const [maxUsesChoice, setMaxUsesChoice] = useState<string>("unlimited");
  const [expiryChoice, setExpiryChoice] = useState<string>("never");
  const [linkLimits, setLinkLimits] = useState<{ maxUses: number | null; expiresAt: string | null }>(
    { maxUses: null, expiresAt: null },
  );
  const [regenerating, setRegenerating] = useState(false);
  const [confirmingRevoke, setConfirmingRevoke] = useState(false);
  const [confirmingUpdate, setConfirmingUpdate] = useState(false);
  const [inviteTab, setInviteTab] = useState<"email" | "link">("email");
  const [copied, setCopied] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const { capabilities } = useServerPermissions();
  // Link-limit options as rUI Select items (these use the default
  // button-scale chrome, see the row below).
  // The "keep current" entry only appears once the loaded link already carries
  // that limit.
  const maxUsesItems = useMemo(
    () => [
      ...(linkLimits.maxUses != null
        ? [{ value: "keep", label: formatMessage({ id: "member.invite.keepCurrent" }) }]
        : []),
      { value: "unlimited", label: formatMessage({ id: "member.invite.unlimited" }) },
      { value: "1", label: "1" },
      { value: "5", label: "5" },
      { value: "10", label: "10" },
      { value: "25", label: "25" },
    ],
    [formatMessage, linkLimits.maxUses],
  );
  const expiryItems = useMemo(
    () => [
      ...(linkLimits.expiresAt != null
        ? [{ value: "keep", label: formatMessage({ id: "member.invite.keepCurrent" }) }]
        : []),
      { value: "never", label: formatMessage({ id: "member.invite.never" }) },
      { value: "1", label: formatMessage({ id: "member.invite.days" }, { count: 1 }) },
      { value: "7", label: formatMessage({ id: "member.invite.days" }, { count: 7 }) },
      { value: "30", label: formatMessage({ id: "member.invite.days" }, { count: 30 }) },
    ],
    [formatMessage, linkLimits.expiresAt],
  );
  const joinUrl = useMemo(() => {
    if (!joinLink) return "";
    // Build from the shareable web origin, not window.location.origin: in the
    // desktop shell the latter is `app://raft`, which yields an unopenable
    // invite link. On Web this is the page origin (unchanged).
    return `${shareableWebOrigin()}/join/${joinLink.token}`;
  }, [joinLink]);
  const humanCount = billing?.usage.humans ?? 0;
  const humanCapacity = billing?.capacity ?? { maxHumans: -1, maxAgents: -1, maxUniversalSeats: -1 };
  const humanUsageState = billing?.usage ?? getBillingUsage(humanCount, 0);
  const humanCapacityLimitState = getBillingCapacityLimitState(humanCapacity, humanUsageState, "human");
  const humanSeatLimitReached = billing != null && humanCapacityLimitState.reached;
  // Every invite takes a seat. Blank rows are ignored by submission, so only a
  // filled-in row blocks the email path.
  const emailInviteSeatLimitReached = humanSeatLimitReached && invitees.some(
    (invitee) => invitee.email.trim() !== "",
  );
  const humanSeatLimitMessage = humanSeatLimitReached
    ? formatBillingCapacityLimitMessage(
      "human",
      humanCapacityLimitState,
      billing.displayName,
      formatMessage({ id: "member.invite.upgradeForMore" }),
    )
    : "";
  // Pro seats (task #10, behind pro_seat_add): for an owner, the line under the
  // title says how many are taken, and they add the seats instead of meeting a
  // disabled Send. Counted by the different people filled in,
  // since each needs a seat to join, not only once the seats are full. Admins keep
  // the notice until they can ask an owner.
  const seatAddEnabled = useServerFeatureFlag(PRO_SEAT_ADD_FEATURE_FLAG_KEY).enabled;
  const seatCapacity = seatAddEnabled && billing?.capacity && billing.capacity.maxUniversalSeats !== -1 ? billing.capacity.maxUniversalSeats : null;
  // An owner adds the seats here; an admin asks an owner for them (task #10).
  const addsSeatsInPlace = seatCapacity !== null;
  const asksOwner = !capabilities.manageBilling;
  const seatUsedTenths = seatTenths(billing?.usage?.humans ?? 0, billing?.usage?.agents ?? 0);
  const seatEmails = [...new Set(invitees
    .filter((invitee) => invitee.email.trim() !== "")
    .map((invitee) => invitee.email.trim().toLowerCase()))];
  const seatPeople = seatEmails.length;
  const seatEmailsKey = seatEmails.join(",");
  // Keyed by the joined emails: the array itself is rebuilt every render.
  const inviteSeatAsk = useMemo(() => ({ purpose: { kind: "invite" as const, emails: seatEmailsKey.split(",").filter(Boolean) } }), [seatEmailsKey]);
  // No one filled in, nothing to add.
  const seatsShort = seatCapacity === null || seatPeople === 0
    ? 0
    : Math.max(0, Math.ceil((seatUsedTenths + seatPeople * PRO_AGENT_SEAT_BLOCK_SIZE) / PRO_AGENT_SEAT_BLOCK_SIZE) - seatCapacity);
  const seatRoomTenths = Math.max(0, (seatCapacity ?? 0) * PRO_AGENT_SEAT_BLOCK_SIZE - seatUsedTenths);
  const formatSeats = (tenths: number) => intl.formatNumber(seatsFromTenths(tenths), { maximumFractionDigits: 1 });
  const seatDescription = !addsSeatsInPlace ? undefined : formatMessage(
    { id: seatsShort > 0 ? "member.invite.seatUsageFull" : "member.invite.seatUsage" },
    { used: formatSeats(seatUsedTenths), seats: seatCapacity ?? 0, people: seatPeople, count: seatsShort },
  );
  // Out of seats, an owner adds them here; anyone else still meets the notice.
  const emailInviteBlocked = emailInviteSeatLimitReached && !addsSeatsInPlace;
  const linkSeatsFull = addsSeatsInPlace && humanSeatLimitReached;
  const formRef = useRef<HTMLFormElement>(null);
  /** The add-seats dialog, and whether the invites go out once the seats count. */
  const [seatNeed, setSeatNeed] = useState<{ need: AddSeatsNeed; send: boolean } | null>(null);
  // Set when the seats were just added: the resumed send runs before this renders
  // the new billing, so it skips the seat check here (the server still checks).
  const resumingAfterSeats = useRef(false);

  useEffect(() => {
    void loadBilling();
  }, [loadBilling]);

  // Adopt a link as the active one AND (re)seed the edit draft + the stable
  // `linkLimits` snapshot from it. Called only on load, a successful generate,
  // and revoke — never on the transient clear inside regenerateLink, so a
  // failed create leaves the draft intact for retry.
  const adoptLink = useCallback((link: JoinLinkRecord | null) => {
    setJoinLink(link);
    const maxUses = link?.maxUses ?? null;
    const expiresAt = link?.expiresAt ?? null;
    setLinkLimits({ maxUses, expiresAt });
    setMaxUsesChoice(maxUses != null ? "keep" : "unlimited");
    setExpiryChoice(expiresAt != null ? "keep" : "never");
  }, []);

  useEffect(() => {
    if (!server) return;
    let cancelled = false;
    setLinkLoading(true);
    setError("");
    void (async () => {
      try {
        const { data: links } = await api.get(`/servers/${server.id}/join-links`);
        const existing = Array.isArray(links) ? links[0] as JoinLinkRecord | undefined : undefined;
        if (existing) {
          if (!cancelled) adoptLink(existing);
          return;
        }
        const { data } = await api.post(`/servers/${server.id}/join-links`, {
          maxUses: null,
          expiresAt: null,
        });
        if (!cancelled) adoptLink(data.link);
      } catch (err: unknown) {
        const axiosErr = err as { response?: { data?: { error?: string } } };
        if (!cancelled) {
          setError(
            axiosErr.response?.data?.error || formatMessage({ id: "member.invite.failedPrepareLink" }),
          );
        }
      } finally {
        if (!cancelled) setLinkLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [server, humanSeatLimitReached, formatMessage, adoptLink]);

  const updateInvitee = useCallback((id: string, patch: InviteePatch) => {
    setInvitees((prev) => prev.map((invitee) => invitee.id === id ? { ...invitee, ...patch } : invitee));
  }, []);

  const addInvitee = useCallback(() => {
    setInvitees((prev) => [...prev, { id: `invitee-${nextInviteeId.current++}`, email: "" }]);
  }, []);

  // The last row is protected by NOT rendering its remove control (below), so
  // there is deliberately no second length check here. A redundant guard in
  // this setter would be unreachable, and unreachable code that looks like a
  // guard implies the path is live.
  const removeInvitee = useCallback((id: string) => {
    setInvitees((prev) => prev.filter((invitee) => invitee.id !== id));
  }, []);

  const handleCopy = useCallback(async () => {
    if (!joinUrl) return;
    await navigator.clipboard.writeText(joinUrl);
    trackFeature("invite", "submit", { surface, variant: "link" });
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }, [joinUrl, surface]);

  const handleInviteTabChange = useCallback((val: "email" | "link" | null) => {
    if (val) setInviteTab(val);
  }, []);

  const handleMaxUsesChange = useCallback((value: string | null) => {
    if (value != null) setMaxUsesChoice(value);
  }, []);

  const handleExpiryChange = useCallback((value: string | null) => {
    if (value != null) setExpiryChoice(value);
  }, []);

  // Regenerate the shareable link with the chosen usage cap / expiry. Revokes
  // the current link (so its token stops working) and creates a fresh one.
  const regenerateLink = useCallback(async () => {
    if (!server || regenerating) return;
    setRegenerating(true);
    setError("");
    // Resolve target limits BEFORE deleting, honouring "keep" = the current
    // link's value, so editing one control never loosens the untouched one.
    const maxUses = maxUsesChoice === "keep" ? linkLimits.maxUses
      : maxUsesChoice === "unlimited" ? null
      : Number(maxUsesChoice);
    const expiresAt = expiryChoice === "keep" ? linkLimits.expiresAt
      : expiryChoice === "never" ? null
      : new Date(Date.now() + Number(expiryChoice) * 24 * 60 * 60 * 1000).toISOString();
    try {
      if (joinLink) {
        await api.delete(`/servers/${server.id}/join-links/${joinLink.id}`);
        // Hide the now-revoked token, but DON'T reseed the draft — if the
        // create below fails, the retry must resend `maxUses`/`expiresAt`.
        setJoinLink(null);
      }
      const { data } = await api.post(`/servers/${server.id}/join-links`, {
        maxUses,
        expiresAt,
      });
      adoptLink(data.link);
      setCopied(false);
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: { error?: string } } };
      setError(axiosErr.response?.data?.error || formatMessage({ id: "member.invite.failedPrepareLink" }));
    } finally {
      setRegenerating(false);
    }
  }, [server, regenerating, maxUsesChoice, linkLimits, expiryChoice, joinLink, adoptLink, formatMessage]);

  // Updating replaces the current link, so the old one stops working for
  // whoever holds it: a named action that asks first, as Revoke does (Raft DS
  // › Forms, "When a change takes effect"). With no link yet there is nothing
  // to invalidate, so it just makes one.
  const handleRegenerateClick = useCallback(() => {
    if (joinLink) setConfirmingUpdate(true);
    else void regenerateLink();
  }, [joinLink, regenerateLink]);
  const closeUpdateConfirm = useCallback(() => setConfirmingUpdate(false), []);

  // Revoke the current link entirely: its token stops working and no
  // replacement is created (the "Update link" button can make a fresh one).
  const revokeLink = useCallback(async () => {
    if (!server || !joinLink || regenerating) return;
    setRegenerating(true);
    setError("");
    try {
      await api.delete(`/servers/${server.id}/join-links/${joinLink.id}`);
      // No replacement: clear the link AND the draft (there is nothing to keep).
      adoptLink(null);
      setCopied(false);
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: { error?: string } } };
      setError(axiosErr.response?.data?.error || formatMessage({ id: "member.invite.failedPrepareLink" }));
    } finally {
      setRegenerating(false);
    }
  }, [server, joinLink, regenerating, adoptLink, formatMessage]);
  // Revoking can't be undone: the token stops working for good, and "Update
  // link" makes a different link. So it asks first, and the red is on the
  // confirmation's button, not on the quiet link that opens it (raft-design
  // button.md: red only for what can't be undone, only in a confirmation).
  const openRevokeConfirm = useCallback(() => setConfirmingRevoke(true), []);
  const closeRevokeConfirm = useCallback(() => setConfirmingRevoke(false), []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const seatsJustAdded = resumingAfterSeats.current;
    resumingAfterSeats.current = false;
    if (!server) return;
    const targets = invitees
      .map((invitee) => ({ email: invitee.email.trim() }))
      .filter((invitee) => invitee.email !== "");
    if (targets.length === 0) {
      setError(formatMessage({ id: "member.invite.enterEmailOrCopyLink" }));
      return;
    }
    if (emailInviteBlocked) {
      setError(humanSeatLimitMessage);
      return;
    }
    setError("");
    for (const target of targets) {
      const emailError = validateEmailAddress(target.email);
      if (emailError) {
        setError(emailError);
        return;
      }
    }
    if (addsSeatsInPlace && seatsShort > 0 && !seatsJustAdded) {
      // Not enough seats for everyone filled in: the owner adds them, then this sends again.
      openInviteSeats();
      return;
    }
    setSending(true);
    // The role is stated explicitly rather than left to a server default.
    const results = await Promise.allSettled(
      targets.map(({ email }) => api.post(`/servers/${server.id}/invites`, { email, role: "member" })),
    );
    // Each address is its own request: the ones the server accepted went out
    // even when another was refused (an existing member, a repeat).
    const sent = results.filter((result) => result.status === "fulfilled").length;
    if (sent > 0) trackFeature("invite", "submit", { surface, variant: "email", count: sent }, { serverId: server.id });
    const refused = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (!refused) {
      onClose();
      nav.toSettings("administration");
      return;
    }
    const axiosErr = refused.reason as { response?: { data?: { error?: string } } };
    setError(axiosErr.response?.data?.error || formatMessage({ id: "member.invite.failedSend" }));
    setSending(false);
  };
  const serverName = server?.name ?? "";
  function openInviteSeats() {
    setSeatNeed({
      send: true,
      need: {
        tenths: seatPeople * PRO_AGENT_SEAT_BLOCK_SIZE,
        label: formatMessage({ id: "addSeats.invite.label" }, { count: seatPeople }),
        title: formatMessage({ id: "addSeats.invite.title" }, { people: seatPeople, count: seatsShort }),
        hint: asksOwner
          ? formatMessage({ id: "addSeats.askHint" }, { server: serverName, seats: seatCapacity ?? 0 })
          : seatRoomTenths > 0
            ? formatMessage({ id: "addSeats.invite.hintRoom" }, { server: serverName, room: seatsFromTenths(seatRoomTenths), people: seatPeople })
            : formatMessage({ id: "addSeats.invite.hint" }, { server: serverName, seats: seatCapacity ?? 0 }),
        resume: formatMessage({ id: "addSeats.invite.resume" }),
        gate: "seat_limit_invite",
      },
    });
  }
  const openLinkSeats = useCallback(() => setSeatNeed({
    send: false,
    need: {
      tenths: PRO_AGENT_SEAT_BLOCK_SIZE,
      label: formatMessage({ id: "addSeats.link.label" }),
      title: formatMessage({ id: "addSeats.link.title" }),
      hint: seatRoomTenths > 0
        ? formatMessage({ id: "addSeats.link.hintRoom" }, { server: serverName, room: seatsFromTenths(seatRoomTenths) })
        : formatMessage({ id: "addSeats.link.hint" }, { server: serverName, seats: seatCapacity ?? 0 }),
      resume: formatMessage({ id: "addSeats.link.resume" }),
      gate: "seat_limit_invite",
    },
  }), [formatMessage, seatCapacity, seatRoomTenths, serverName]);
  const closeSeats = useCallback(() => setSeatNeed(null), []);
  // The seats count now (billing has the new number): send what was filled in, or
  // for the link, nothing more to do.
  const handleSeatsAdded = useCallback(() => {
    setSeatNeed(null);
    if (!seatNeed?.send) return;
    resumingAfterSeats.current = true;
    formRef.current?.requestSubmit();
  }, [seatNeed]);

  return (
    <>
    <DialogCard title={formatMessage({ id: "member.invite.title" })} description={seatDescription} onClose={onClose} maxWidthClass="max-w-lg" narrow="sheet">
        <form ref={formRef} onSubmit={handleSubmit} className="stack-y-4 md:pointer-fine:stack-y-3">
          {error && !emailInviteBlocked && (
            <Banner intent="warning">
              {error}
              {isBillingGateError(error) && (
                <>
                  {" "}
                  <PaywallShown gate="seat_limit_invite" />
                  <TextLink
                    variant="strong"
                    onClick={openBillingSettings}
                  >
                    {formatMessage({ id: "member.invite.viewBilling" })}
                  </TextLink>
                </>
              )}
            </Banner>
          )}

          {emailInviteBlocked && (
            <Banner intent="warning">
              {humanSeatLimitMessage}{" "}
              <PaywallShown gate="seat_limit_invite" />
              <TextLink
                variant="strong"
                onClick={openBillingSettings}
              >
                {formatMessage({ id: "member.invite.viewBilling" })}
              </TextLink>
            </Banner>
          )}

          {/* A link costs no seat, but no one gets in through it while the seats are full:
              something to fix, so warning (Kirby). The description above already says
              how many are used, so this says what follows. */}
          {inviteTab === "link" && linkSeatsFull && (
            <Banner
              intent="warning"
              withIcon
              live={false}
              title={formatMessage({ id: "member.invite.linkFullTitle" }, { server: serverName })}
              actions={asksOwner ? undefined : (
                <Button type="button" variant="default" size="md" onClick={openLinkSeats} data-testid="invite-link-add-seats">
                  {formatMessage({ id: "member.invite.linkAddSeats" })}
                </Button>
              )}
              data-testid="invite-link-seats-full"
            >
              {formatMessage({ id: "member.invite.linkFullBody" })}
            </Banner>
          )}

          {/* Stopgap until per-agent access control (task #121): any member can
              DM and direct every agent in the server, so say so before inviting. */}
          {/* One notice at a time: while the link can't let anyone in, that's the one. */}
          {!(inviteTab === "link" && linkSeatsFull) && (
          <Banner intent="info" withIcon data-testid="invite-agent-reach-hint">
            {formatMessage({ id: "member.invite.agentReachHint" })}
          </Banner>
          )}

          {/* Invite method tabs (Phase 3): email vs shareable link. */}
          <SegmentedControl<"email" | "link">
            value={inviteTab}
            onValueChange={handleInviteTabChange}
            // Full width, so the two methods share the track equally.
            className="w-full *:flex-1"
            data-testid="invite-method-tabs"
          >
            <SegmentedControlItem value="email" data-testid="invite-tab-email">
              <SegmentedControlLabel>{formatMessage({ id: "member.invite.tabEmail" })}</SegmentedControlLabel>
            </SegmentedControlItem>
            <SegmentedControlItem value="link" data-testid="invite-tab-link">
              <SegmentedControlLabel>{formatMessage({ id: "member.invite.tabLink" })}</SegmentedControlLabel>
            </SegmentedControlItem>
          </SegmentedControl>

          {inviteTab === "email" && (
          <div>
            <label className={FIELD_LABEL_CLASS}>
              {formatMessage({ id: "member.invite.byEmail" })}
            </label>
            <div className="stack-y-2">
              {invitees.map((invitee, index) => (
                <InviteeRow
                  key={invitee.id}
                  invitee={invitee}
                  index={index}
                  fieldIdPrefix={inviteeFieldId}
                  canRemove={invitees.length > 1}
                  onUpdate={updateInvitee}
                  onRemove={removeInvitee}
                />
              ))}
            </div>
            <div className="mt-2">
              {/* No colour override: `variant="ghost"` already carries the
                  themed treatment, and a literal here could not follow the
                  theme (@cindyz, PR #7010). */}
              <Button type="button" size="md" variant="ghost" onClick={addInvitee}>
                <Plus size={16} aria-hidden="true" />
                {formatMessage({ id: "member.invite.addInvitee" })}
              </Button>
            </div>
          </div>

          )}

          {inviteTab === "link" && (
          <div>
            <label className={FIELD_LABEL_CLASS}>
              {formatMessage({ id: "member.invite.linkLabel" })}
            </label>
            <div className="flex items-center gap-2">
              {/* readOnly Input rather than a bordered div: a literal
                  `border-2 border-black` kept a heavy edge while everything
                  around it went soft (@cindyz). The Input picks up the same
                  field metrics as the rows above. */}
              <Field className="contents">
                <Input
                  readOnly
                  aria-label={formatMessage({ id: "member.invite.linkLabel" })}
                  value={linkLoading
                    ? formatMessage({ id: "member.invite.preparingLink" })
                    : joinUrl || formatMessage({ id: "member.invite.linkUnavailable" })}
                  className="min-w-0 flex-1 truncate font-mono text-mono-code"
                />
              </Field>
              <Tooltip content={formatMessage({ id: "member.invite.copyLinkTitle" })}>
              <Button
                type="button"
                onClick={handleCopy}
                disabled={!joinUrl || linkLoading || regenerating}
                size="icon-lg"
                variant="outline"
                className="shrink-0"
                aria-label={formatMessage({ id: "member.invite.copyLinkTitle" })}
                data-slot="button"
              >
                {copied ? <Check size={20} aria-hidden="true" /> : <Copy size={20} aria-hidden="true" />}
              </Button>
              </Tooltip>
            </div>
            {/* Optional link limits (Phase 1). Purely additive: leaving the
                defaults keeps the unlimited, non-expiring link. */}
            {/* Link-limit controls sit beside a `size="md"` Button (h-8), not
                beside an Input, so they use the Select's DEFAULT chrome (the
                Button size scale) rather than `chrome="field"` — field metrics
                made them tower over both the labels and the button (task #98).
                Labels never wrap or clip; each label+control pair stays together. */}
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
              <label htmlFor={`${inviteeFieldId}-max-uses`} className="flex items-center gap-1.5">
                <span className="whitespace-nowrap text-footnote font-semibold text-foreground-muted">
                  {formatMessage({ id: "member.invite.maxUsesLabel" })}
                </span>
                <Select
                  value={maxUsesChoice}
                  onValueChange={handleMaxUsesChange}
                  items={maxUsesItems}
                >
                  <SelectTrigger
                    id={`${inviteeFieldId}-max-uses`}
                    className="w-32 shrink-0"
                    aria-label={formatMessage({ id: "member.invite.maxUsesLabel" })}
                  >
                    <SelectValue />
                    <SelectIcon />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectList>
                      {maxUsesItems.map((item) => (
                        <SelectItem key={item.value} value={item.value}>
                          <SelectItemText>{item.label}</SelectItemText>
                          <SelectItemIndicator />
                        </SelectItem>
                      ))}
                    </SelectList>
                  </SelectContent>
                </Select>
              </label>
              <label htmlFor={`${inviteeFieldId}-expiry`} className="flex items-center gap-1.5">
                <span className="whitespace-nowrap text-footnote font-semibold text-foreground-muted">
                  {formatMessage({ id: "member.invite.expiresLabel" })}
                </span>
                <Select
                  value={expiryChoice}
                  onValueChange={handleExpiryChange}
                  items={expiryItems}
                >
                  <SelectTrigger
                    id={`${inviteeFieldId}-expiry`}
                    className="w-32 shrink-0"
                    aria-label={formatMessage({ id: "member.invite.expiresLabel" })}
                  >
                    <SelectValue />
                    <SelectIcon />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectList>
                      {expiryItems.map((item) => (
                        <SelectItem key={item.value} value={item.value}>
                          <SelectItemText>{item.label}</SelectItemText>
                          <SelectItemIndicator />
                        </SelectItem>
                      ))}
                    </SelectList>
                  </SelectContent>
                </Select>
              </label>
              <Button
                type="button"
                size="md"
                variant="outline"
                onClick={handleRegenerateClick}
                disabled={regenerating || linkLoading || !server}
              >
                {formatMessage({ id: "member.invite.applyLinkOptions" })}
              </Button>
              {joinLink && (
                <TextLink
                  onClick={openRevokeConfirm}
                  disabled={regenerating}
                  data-testid="invite-link-revoke"
                  className="text-footnote"
                >
                  {formatMessage({ id: "member.invite.revokeLink" })}
                </TextLink>
              )}
            </div>
            {joinLink && (
              <p className="mt-1.5 text-caption text-foreground-hint">
                {formatMessage({ id: "member.invite.updateReplacesHint" })}
              </p>
            )}
            {joinLink && (joinLink.maxUses != null || joinLink.expiresAt != null) && (
              <div className="mt-1.5 text-caption text-foreground-hint" data-testid="invite-link-status">
                {joinLink.maxUses != null && formatMessage(
                  { id: "member.invite.usedOf" },
                  { used: joinLink.useCount ?? 0, max: joinLink.maxUses },
                )}
                {joinLink.maxUses != null && joinLink.expiresAt != null && " · "}
                {joinLink.expiresAt != null && formatMessage(
                  { id: "member.invite.expiresOn" },
                  { date: intl.formatDate(joinLink.expiresAt) },
                )}
              </div>
            )}
            <div className="mt-1.5 flex items-center gap-1.5 text-caption text-foreground-hint">
              <Link size={14} aria-hidden="true" />
              {humanSeatLimitReached && !linkSeatsFull
                ? formatMessage({ id: "member.invite.seatLimitHint" })
                : formatMessage({ id: "member.invite.sendLinkHint" })}
            </div>
          </div>
          )}

          <DialogCardFooter>
            <Button size="lg"
              variant="ghost"
              type="button"
              onClick={onClose}
            >
              {formatMessage({ id: "common.confirm.cancel" })}
            </Button>
            {inviteTab === "email" && (
              <DialogCommit>
                {(inHead) => (
                  <Button size={inHead ? "md" : "lg"}
                    variant="primary"
                    type="submit"
                    disabled={sending || emailInviteBlocked}
                  >
                    <Mail size={18} aria-hidden="true" />
                    {sending
                      ? formatMessage({ id: "member.invite.sending" })
                      : formatMessage({ id: "member.invite.sendInvites" })}
                  </Button>
                )}
              </DialogCommit>
            )}
          </DialogCardFooter>
        </form>
      {confirmingUpdate && (
        <ConfirmDialog
          title={formatMessage({ id: "member.invite.updateConfirmTitle" })}
          message={formatMessage({ id: "member.invite.updateConfirmMessage" })}
          confirmLabel={formatMessage({ id: "member.invite.applyLinkOptions" })}
          loadingLabel={formatMessage({ id: "member.invite.updatingLink" })}
          layer={1}
          confirmTestId="invite-link-update-confirm"
          analyticsDialog="invite_link_update"
          onConfirm={regenerateLink}
          onClose={closeUpdateConfirm}
        />
      )}
      {confirmingRevoke && (
        <ConfirmDialog
          title={formatMessage({ id: "settings.joinLinks.confirmTitle" })}
          message={formatMessage({ id: "settings.joinLinks.confirmMessage" })}
          confirmLabel={formatMessage({ id: "settings.joinLinks.confirmLabel" })}
          loadingLabel={formatMessage({ id: "settings.joinLinks.revoking" })}
          layer={1}
          confirmTestId="invite-link-revoke-confirm"
          onConfirm={revokeLink}
          onClose={closeRevokeConfirm}
        />
      )}
    </DialogCard>
    {/* Beside the invite dialog, not in it, so it stacks over it as over Create Agent. */}
    {seatNeed ? (
      <AddSeatsDialog
        need={seatNeed.need}
        onClose={closeSeats}
        onAdded={handleSeatsAdded}
        // An admin asks an owner for the seats; once added, the invites go out from the admin.
        ask={asksOwner && seatNeed.send ? inviteSeatAsk : undefined}
        onSent={onClose}
      />
    ) : null}
    </>
  );
}
