import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useIntl } from "react-intl";
import { Check, Copy, Link2, Mail, Plus, Trash2 } from "lucide-react";
import {
  Button,
  Field,
  Input,
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
import type { ServerRole } from "@botiverse/raft-shared";
import { SERVER_GUEST_FEATURE_FLAG_KEY, formatBillingCapacityLimitMessage, getBillingCapacityLimitState, getBillingUsage, validateEmailAddress } from "@botiverse/raft-shared";
import { useServerStore } from "../../store/serverStore";
import { useServerFeatureFlag } from "../../store/serverFeatureFlags";
import { useServerPermissions } from "../../hooks/useServerPermissions";
import { useAppNavigate } from "../../hooks/useAppNavigate";
import api from "../../api/client";
import DialogCard from "../ui/DialogCard";
import Banner from "../ui/Banner";

/**
 * The roles an invite can grant. Derived from the shared `ServerRole` union
 * rather than restated as a free-standing `"member" | "guest"`: the server's own
 * `InvitableServerRole` lives in `inviteService.ts`, which the web cannot
 * import, so this is the closest thing to one source of truth. If `ServerRole`
 * ever loses either member, this stops compiling instead of drifting quietly.
 */
type InvitableRole = Extract<ServerRole, "member" | "guest">;

/**
 * `id` is a stable React key that survives removal of an earlier row. Index
 * keys would reuse a removed row's identity and carry the wrong text into the
 * wrong box.
 */
interface Invitee {
  id: string;
  email: string;
  role: InvitableRole;
}

interface JoinLinkRecord {
  id: string;
  token: string;
}

function isBillingGateError(error: string) {
  return error.includes("seat limit") || error.includes("limit reached") || error.includes("requires the Pro plan");
}

export default function InviteHumanDialog({
  onClose,
}: {
  onClose: () => void;
}) {
  const { formatMessage } = useIntl();
  const server = useServerStore((s) => s.current);
  const billing = useServerStore((s) => s.billing);
  const loadBilling = useServerStore((s) => s.loadBilling);
  const nav = useAppNavigate();
  /**
   * One row per person, each carrying its OWN role.
   *
   * Previously this was three fixed email strings plus a single dialog-wide
   * role. That shape could not express "two colleagues and one outside guest" —
   * every invite in the batch was forced to the same grant, and nothing in the
   * UI said so (@cindyz). Role now lives on the row it applies to.
   *
   * Starts at one row rather than three empty boxes: rows are addable, so three
   * placeholders only asked a question most inviters do not have.
   */
  const [invitees, setInvitees] = useState<Invitee[]>(() => [{ id: "invitee-0", email: "", role: "member" }]);
  const nextInviteeId = useRef(1);
  const inviteeFieldId = useId();
  const [joinLink, setJoinLink] = useState<JoinLinkRecord | null>(null);
  const [linkLoading, setLinkLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const guestEnabled = useServerFeatureFlag(SERVER_GUEST_FEATURE_FLAG_KEY).enabled;
  const { capabilities } = useServerPermissions();
  /**
   * Guest is offered only when the server has the capability turned on AND the
   * caller is allowed to invite at all. Both halves are optimistic: this is a
   * client-side read of a server-owned gate, so it can be stale. It decides what
   * to OFFER, never what is permitted — see `handleSubmit`.
   */
  const canOfferGuest = guestEnabled && capabilities.inviteMembers;
  const roleItems = useMemo(
    () => [
      { value: "member", label: formatMessage({ id: "member.invite.roleMember" }) },
      { value: "guest", label: formatMessage({ id: "member.invite.roleGuest" }) },
    ],
    [formatMessage],
  );
  const joinUrl = useMemo(() => {
    if (!joinLink) return "";
    return `${window.location.origin}/join/${joinLink.token}`;
  }, [joinLink]);
  const humanCount = billing?.usage.humans ?? 0;
  const humanCapacity = billing?.capacity ?? { maxHumans: -1, maxAgents: -1, maxUniversalSeats: -1 };
  const humanUsageState = billing?.usage ?? getBillingUsage(humanCount, 0);
  const humanCapacityLimitState = getBillingCapacityLimitState(humanCapacity, humanUsageState, "human");
  const humanSeatLimitReached = billing != null && humanCapacityLimitState.reached;
  const humanSeatLimitMessage = humanSeatLimitReached
    ? formatBillingCapacityLimitMessage(
      "human",
      humanCapacityLimitState,
      billing.displayName,
      formatMessage({ id: "member.invite.upgradeForMore" }),
    )
    : "";

  useEffect(() => {
    void loadBilling();
  }, [loadBilling]);

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
          if (!cancelled) setJoinLink(existing);
          return;
        }
        const { data } = await api.post(`/servers/${server.id}/join-links`, {
          maxUses: null,
          expiresAt: null,
        });
        if (!cancelled) setJoinLink(data.link);
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
  }, [server, humanSeatLimitReached, formatMessage]);

  const updateInvitee = (id: string, patch: Partial<Omit<Invitee, "id">>) => {
    setInvitees((prev) => prev.map((invitee) => invitee.id === id ? { ...invitee, ...patch } : invitee));
  };

  const addInvitee = () => {
    setInvitees((prev) => [...prev, { id: `invitee-${nextInviteeId.current++}`, email: "", role: "member" }]);
  };

  // The last row is protected by NOT rendering its remove control (below), so
  // there is deliberately no second length check here. A redundant guard in
  // this setter would be unreachable, and unreachable code that looks like a
  // guard implies the path is live.
  const removeInvitee = (id: string) => {
    setInvitees((prev) => prev.filter((invitee) => invitee.id !== id));
  };

  const handleCopy = async () => {
    if (!joinUrl) return;
    await navigator.clipboard.writeText(joinUrl);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!server) return;
    if (humanSeatLimitReached) {
      setError(humanSeatLimitMessage);
      return;
    }
    const targets = invitees
      .map((invitee) => ({ email: invitee.email.trim(), role: invitee.role }))
      .filter((invitee) => invitee.email !== "");
    if (targets.length === 0) {
      setError(formatMessage({ id: "member.invite.enterEmailOrCopyLink" }));
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
    setSending(true);
    try {
      // The chosen role goes to the server as chosen. Deliberately NOT
      // pre-filtered by `canOfferGuest`: that flag is a possibly-stale client
      // read, and silently rewriting guest->member here would hand out a WIDER
      // grant than the inviter picked, with nothing in the UI saying so. The
      // server refuses (400) rather than downgrading, and the catch below shows
      // its message verbatim.
      await Promise.all(
        targets.map(({ email, role }) => api.post(`/servers/${server.id}/invites`, { email, role })),
      );
      onClose();
      nav.toSettings("administration");
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: { error?: string } } };
      setError(axiosErr.response?.data?.error || formatMessage({ id: "member.invite.failedSend" }));
      setSending(false);
    }
  };

  return (
    <DialogCard title={formatMessage({ id: "member.invite.title" })} onClose={onClose} maxWidthClass="max-w-lg">
        <form onSubmit={handleSubmit} className="space-y-4">
          {error && !humanSeatLimitReached && (
            <Banner intent="warning" className="font-bold">
              {error}
              {isBillingGateError(error) && (
                <>
                  {" "}
                  <button
                    type="button"
                    onClick={() => {
                      onClose();
                      nav.toSettings("billing");
                    }}
                    className="font-bold text-black underline"
                  >
                    {formatMessage({ id: "member.invite.viewBilling" })}
                  </button>
                </>
              )}
            </Banner>
          )}

          {humanSeatLimitReached && (
            <Banner intent="warning" className="font-bold">
              {humanSeatLimitMessage}{" "}
              <button
                type="button"
                onClick={() => {
                  onClose();
                  nav.toSettings("billing");
                }}
                className="font-bold text-black underline"
              >
                {formatMessage({ id: "member.invite.viewBilling" })}
              </button>
            </Banner>
          )}

          <div>
            <label className="mb-1 block text-sm font-bold text-foreground-strong uppercase tracking-wide">
              {formatMessage({ id: "member.invite.byEmail" })}
            </label>
            <div className="space-y-2">
              {invitees.map((invitee, index) => (
                <div key={invitee.id} className="flex items-center gap-2">
                  {/*
                    * Each control gets its OWN `Field className="contents"`.
                    *
                    * Base UI's Field context hands every Input beneath it the
                    * same control id and the same `aria-labelledby`, so a list
                    * of rows would collapse into one id and every box would
                    * announce the group's label. An inherited `aria-labelledby`
                    * also outranks `aria-label`, so labelling them directly
                    * does not help while they share a context. `contents` adds
                    * no layout. (Found by @Dozy on PR #7010.)
                    */}
                  <Field className="contents">
                    <Input
                      id={`${inviteeFieldId}-email-${invitee.id}`}
                      type="email"
                      aria-label={formatMessage({ id: "member.invite.emailLabel" })}
                      value={invitee.email}
                      onChange={(event) => updateInvitee(invitee.id, { email: event.target.value })}
                      className="min-w-0 flex-1"
                      placeholder="name@company.com"
                    />
                  </Field>
                  {canOfferGuest && (
                    <Select
                      // `chrome="field"` opts into rUI's field metric axis, so
                      // the trigger takes the same height and typography as the
                      // Input beside it. Its default chrome borrows the Button
                      // size scale (32px / 14px) because the trigger is built on
                      // Button — which is why the row read as two different
                      // kinds of control. Hand-setting a height would have
                      // matched only the number, not the type scale.
                      chrome="field"
                      value={invitee.role}
                      onValueChange={(value) => {
                        if (value != null) updateInvitee(invitee.id, { role: value as InvitableRole });
                      }}
                      items={roleItems}
                    >
                      <SelectTrigger
                        id={`${inviteeFieldId}-role-${invitee.id}`}
                        className="w-28 shrink-0"
                        aria-label={formatMessage({ id: "member.invite.roleLabel" })}
                      >
                        <SelectValue />
                        <SelectIcon />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectList>
                          {roleItems.map((item) => (
                            <SelectItem key={item.value} value={item.value}>
                              <SelectItemText>{item.label}</SelectItemText>
                              <SelectItemIndicator />
                            </SelectItem>
                          ))}
                        </SelectList>
                      </SelectContent>
                    </Select>
                  )}
                  {/* Hidden, not disabled, at one row: removing the last row
                      leaves no way back to a usable form. */}
                  {invitees.length > 1 && (
                    <Button
                      type="button"
                      size="icon-xs"
                      variant="default"
                      onClick={() => removeInvitee(invitee.id)}
                      aria-label={formatMessage({ id: "member.invite.removeInvitee" }, { index: index + 1 })}
                    >
                      <Trash2 size={14} />
                    </Button>
                  )}
                </div>
              ))}
            </div>
            <div className="mt-2">
              {/* No colour override: `variant="ghost"` already carries the
                  themed treatment, and a literal here could not follow the
                  theme (@cindyz, PR #7010). */}
              <Button type="button" size="sm" variant="ghost" onClick={addInvitee}>
                <Plus size={14} />
                {formatMessage({ id: "member.invite.addInvitee" })}
              </Button>
            </div>
          </div>

          <div className="flex items-center gap-3 text-[11px] font-bold uppercase tracking-widest text-black/40">
            <div className="h-px flex-1 bg-black/20" />
            <span>{formatMessage({ id: "member.invite.or" })}</span>
            <div className="h-px flex-1 bg-black/20" />
          </div>

          <div>
            <label className="mb-1 block text-sm font-bold text-foreground-strong uppercase tracking-wide">
              {formatMessage({ id: "member.invite.linkLabel" })}
            </label>
            <div className="flex items-center gap-2">
              {/* readOnly Input rather than a bordered div: `border-2
                  border-black` was a literal, so this box kept its heavy brutal
                  edge under the elegant theme while everything around it went
                  soft (@cindyz). The Input follows the theme and picks up the
                  same field metrics as the rows above. */}
              <Field className="contents">
                <Input
                  readOnly
                  aria-label={formatMessage({ id: "member.invite.linkLabel" })}
                  value={linkLoading
                    ? formatMessage({ id: "member.invite.preparingLink" })
                    : joinUrl || formatMessage({ id: "member.invite.linkUnavailable" })}
                  className="min-w-0 flex-1 truncate font-mono text-xs"
                />
              </Field>
              <Button
                type="button"
                onClick={handleCopy}
                disabled={!joinUrl || linkLoading}
                size="icon-md"
                variant="default"
                className="shrink-0"
                title={formatMessage({ id: "member.invite.copyLinkTitle" })}
                aria-label={formatMessage({ id: "member.invite.copyLinkTitle" })}
              >
                {copied ? <Check size={14} /> : <Copy size={14} />}
              </Button>
            </div>
            <div className="mt-1 flex items-center gap-1 text-xs text-foreground-muted">
              <Link2 size={12} />
              {humanSeatLimitReached
                ? formatMessage({ id: "member.invite.seatLimitHint" })
                : formatMessage({ id: "member.invite.sendLinkHint" })}
            </div>
          </div>

          <div className="flex justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              className="btn-brutal bg-white px-4 py-2 text-sm"
            >
              {formatMessage({ id: "common.confirm.cancel" })}
            </button>
            <button
              type="submit"
              disabled={sending || humanSeatLimitReached}
              className="btn-brutal bg-brutal-pink px-4 py-2 text-sm flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Mail size={14} />
              {sending
                ? formatMessage({ id: "member.invite.sending" })
                : formatMessage({ id: "member.invite.sendInvites" })}
            </button>
          </div>
        </form>
    </DialogCard>
  );
}
