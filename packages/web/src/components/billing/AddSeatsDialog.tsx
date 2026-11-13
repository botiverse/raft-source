import { useCallback, useEffect, useRef, useState } from "react";
import type { ChangeEvent, ReactNode } from "react";
import { useIntl } from "react-intl";
import { Minus, Plus } from "lucide-react";
import {
  Textarea,
  FieldError,
  FieldLabel,
  Field,
  Input,
  Button,
  Separator,
  TextLink,
  TextLinkExternalIcon,
  ScrollArea,
} from "@botiverse/raft-ui";
import { PRO_AGENT_SEAT_BLOCK_SIZE, SEAT_REQUEST_REASON_MAX_LENGTH, seatTenths } from "@botiverse/raft-shared";
import type { BillingEntry, PaywallGate, SeatsAddPurpose } from "@botiverse/raft-shared";
import api from "../../api/client";
import { trackPaywallAction, usePaywallShown } from "../../analytics/paywall";
import { useAppNavigate } from "../../hooks/useAppNavigate";
import { OwnerPicker, ownerName, requestCardOwner, useOwnerRecipient } from "./OwnerPicker";
import { useServerStore } from "../../store/serverStore";
import { formatBillingAmount } from "../../utils/formatBillingAmount";
import Banner from "../ui/Banner";
import { showToast } from "../toastBridge";
import { purposeCopyValues } from "./seatRequestCopy";
import BillingWaiting from "./BillingWaiting";
import { billingServerError } from "./billingServerError";
import { PayingView, PriceRow, RoomLine, SeatsFrame } from "./AddSeatsParts";
import { PrepaidSeatsPart } from "./PrepaidSeatsPart";

const TEST_ID = "add-seats-dialog";
/** Ask Stripe for the price once the count settles, not on every click of + (previews are rate limited). */
const PREVIEW_SETTLE_MS = 300;
/** While Stripe confirms: read the seats again this often, this many times. The webhook usually lands first; this covers a slow one. */
const CONFIRM_POLL_MS = 3_000;
const CONFIRM_POLL_LIMIT = 20;
/** Ask for a fresh price this long before Stripe's preview token expires (it lives 5 minutes). */
const PREVIEW_REFRESH_MARGIN_MS = 30_000;

/** What the blocked action needs, said in the caller's words. */
export interface AddSeatsNeed {
  /** The seats it needs, in tenths: an agent is 1, a person 10. */
  tenths: number;
  /** The row that runs past the seats bought: "+ Scout × 0.1". */
  label: string;
  title: string;
  hint: string;
  /** The waiting view's last sentence: what happens once paid. */
  resume: string;
  /** The paywall it stands in for; unset from Plan & Billing, which isn't one (no paywall events). */
  gate?: Extract<PaywallGate, "seat_limit_agent_create" | "seat_limit_invite">;
  /**
   * From Plan & Billing (no `gate`): the seat update's billing entry, the
   * paywall that opened the page or `settings`. Only there can a promotion
   * code be added, as on the page's old seat form.
   */
  entry?: BillingEntry;
}

interface SeatPreview {
  currency: string;
  prorationAmount: number;
  recurringAmount: number;
  discountAmount?: number;
  promotion?: { code: string } | null;
  previewToken: string;
  expiresAt?: string;
}

interface SeatUpdate {
  status: "unchanged" | "updated" | "reactivated" | "pending_payment" | "pending_webhook" | "scheduled_period_end";
  heldPayment?: { url: string | null; action: "authenticate" | "update_payment_method" | null };
}

/** What the owner paid for: the seat count that ends the wait, and how many it added. */
interface Paid {
  target: number;
  count: number;
}

type Stage =
  | { kind: "choose" }
  | { kind: "paying" | "held"; paid: Paid }
  | { kind: "bank" | "declined"; url: string; paid: Paid };

/** Stripe's price for a count (and code), and the last code Stripe refused, with its reason. */
interface PreviewState {
  seats: number;
  code: string;
  data: SeatPreview | null;
  error: string;
  refused: string;
  refusedError: string;
}

const NO_PREVIEW: PreviewState = { seats: 0, code: "", data: null, error: "", refused: "", refusedError: "" };
/** Plan & Billing's promotion code: the field shown, what is typed, and the code applied. */
const NO_PROMO = { open: false, input: "", code: "" };

/**
 * Add Pro seats where an action ran out of them (task #10, #proj-commercial),
 * in the upgrade dialog's frame (720×520; Raft Design System › Dialog lists
 * it there, cindyz 2026-10-26): why the seats ran out on the left, how many to
 * add and Stripe's price on the right. Owners only: the caller checks
 * `manageBilling`. On a subscription Stripe charges its card at once; on
 * prepaid Pro (task #19) the owner pays the days left once with Alipay
 * (PrepaidSeatsPart). Either way the dialog waits until the seats count, then
 * `onAdded` lets the caller carry on.
 */
export default function AddSeatsDialog({
  need,
  onClose,
  onPaid,
  onAdded,
  ask,
  onSent,
}: {
  need: AddSeatsNeed;
  onClose: () => void;
  /** Stripe charged for the seats; they count once its webhook lands (then `onAdded`). Not for a payment Stripe held. */
  onPaid?: () => void;
  onAdded: () => void;
  /**
   * Set for an admin or member (no `manageBilling`): the right half asks an
   * owner instead, with a seat request card for `purpose`. `usage` when the
   * viewer can't read billing (a member): the numbers from the refusal.
   */
  ask?: { purpose: SeatsAddPurpose; usage?: SeatUsage };
  /** The request went out: the asker is done, so the dialog it came from closes too (design 8). */
  onSent?: () => void;
}) {
  // Counted once per session and gate, like the notice it stands in for.
  usePaywallShown(need.gate);
  // Prepaid Pro (task #19) has no subscription: its owner pays the days left once, with Alipay.
  const prepaid = useServerStore((state) => state.billing?.source === "prepaid");
  if (ask) return <AskSeatsPart need={need} ask={ask} onClose={onClose} onSent={onSent} />;
  return prepaid
    ? <PrepaidSeatsPart need={need} onClose={onClose} onAdded={onAdded} />
    : <OwnerSeatsPart need={need} onClose={onClose} onPaid={onPaid} onAdded={onAdded} />;
}

/** What was bought and what takes it: from billing, or from a refusal's numbers. */
export interface SeatUsage {
  seats: number;
  humans: number;
  agents: number;
}

function OwnerSeatsPart({
  need,
  onClose,
  onPaid,
  onAdded,
}: {
  need: AddSeatsNeed;
  onClose: () => void;
  onPaid?: () => void;
  onAdded: () => void;
}) {
  const { formatMessage, formatDate, locale } = useIntl();
  const billing = useServerStore((state) => state.billing);
  const loadBilling = useServerStore((state) => state.loadBilling);
  const serverName = useServerStore((state) => state.current?.name ?? "");

  const seats = Math.max(0, billing?.capacity?.maxUniversalSeats ?? 0);
  const usedTenths = seatTenths(billing?.usage?.humans ?? 0, billing?.usage?.agents ?? 0);
  const minimumAdd = Math.max(1, Math.ceil((usedTenths + need.tenths) / PRO_AGENT_SEAT_BLOCK_SIZE) - seats);
  const [extra, setExtra] = useState(0);
  const add = minimumAdd + extra;
  const requested = seats + add;

  const [stage, setStage] = useState<Stage>({ kind: "choose" });
  const paid = stage.kind === "choose" ? null : stage.paid;
  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<PreviewState>(NO_PREVIEW);
  /** Bumped to ask Stripe again for the same count: a retry, a refused token, or one about to expire. */
  const [previewRound, setPreviewRound] = useState(0);
  // Plan & Billing only: a promotion code, priced in with the seats (Stripe checks it).
  const promoAllowed = !need.gate;
  const [promo, setPromo] = useState(NO_PROMO);
  // The code priced in: the one applied, unless Stripe refused it (then the seats are priced without it).
  const promoCode = promo.code && promo.code !== preview.refused ? promo.code : "";

  // Stripe's price for this count: an outside system, asked again when the count settles.
  useEffect(() => {
    if (paid) return;
    let ignore = false;
    const timer = window.setTimeout(() => {
      api.post<SeatPreview>("/billing/seat-pack-quantity/preview", { seatQuantity: requested, ...(promoCode ? { promotionCode: promoCode } : {}) })
        .then(({ data }) => {
          if (!ignore) setPreview((state) => ({ ...state, seats: requested, code: promoCode, data, error: "" }));
        })
        .catch((err: unknown) => {
          if (ignore) return;
          // Stripe refused the code (400): it is set aside, said beside the field, and the
          // seats priced without it. Anything else (a busy or failing Stripe) keeps the code
          // and asks for a retry, as without one.
          setPreview((state) => promoCode && (err as { response?: { status?: number } }).response?.status === 400
            ? { ...state, refused: promoCode, refusedError: billingServerError(err) || formatMessage({ id: "addSeats.promoFailed" }) }
            : { ...state, seats: requested, code: promoCode, data: null, error: billingServerError(err) || formatMessage({ id: "addSeats.previewFailed" }) });
        });
    }, PREVIEW_SETTLE_MS);
    return () => {
      ignore = true;
      window.clearTimeout(timer);
    };
  }, [formatMessage, paid, previewRound, promoCode, requested]);
  // Ask again shortly before the price's token expires. A timer, because the
  // token's lifetime is the server's, not something this dialog renders.
  const tokenExpiresAt = preview.data?.expiresAt ? Date.parse(preview.data.expiresAt) : Number.NaN;
  useEffect(() => {
    if (paid || !Number.isFinite(tokenExpiresAt)) return;
    const timer = window.setTimeout(() => setPreviewRound((round) => round + 1), Math.max(0, tokenExpiresAt - Date.now() - PREVIEW_REFRESH_MARGIN_MS));
    return () => window.clearTimeout(timer);
  }, [paid, tokenExpiresAt]);
  const askPriceAgain = useCallback(() => {
    setPreview((state) => ({ ...NO_PREVIEW, refused: state.refused, refusedError: state.refusedError }));
    setPreviewRound((round) => round + 1);
  }, []);
  const current = preview.seats === requested && preview.code === promoCode;
  const price = current ? preview.data : null;
  const previewError = current ? preview.error : "";
  // Stripe's reason for a refused code, while that code is still what's typed.
  const promoError = preview.refused && promo.input.trim() === preview.refused ? preview.refusedError : "";
  const handlePromoInput = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget.value;
    setPromo((state) => ({ ...state, input }));
  }, []);
  const openPromo = useCallback(() => setPromo((state) => ({ ...state, open: true })), []);
  // Applying asks Stripe again, even for a code it refused before.
  const applyPromo = useCallback(() => {
    setPreview((state) => ({ ...state, refused: "", refusedError: "" }));
    setPromo((state) => ({ ...state, code: state.input.trim() }));
  }, []);
  const removePromo = useCallback(() => setPromo({ ...NO_PROMO, open: true }), []);

  // Paid: the seats count once Stripe's webhook lands (server:plan-updated reloads
  // billing). The billing store is the outside system here: subscribe to it, and
  // carry on (once per dialog) when it has the new count.
  const announced = useRef(false);
  useEffect(() => {
    if (!paid) return;
    const check = () => {
      const now = useServerStore.getState().billing?.capacity?.maxUniversalSeats ?? 0;
      if (announced.current || now < paid.target) return;
      announced.current = true;
      showToast({
        title: formatMessage({ id: "addSeats.addedToast" }, { count: paid.count }),
        description: formatMessage({ id: "addSeats.addedToastDescription" }, { server: serverName, seats: now }),
        type: "success",
        data: { intent: "success" },
      });
      onAdded();
    };
    const unsubscribe = useServerStore.subscribe(check);
    // The new count may already be there: billing can reload between the
    // commit that shows the wait and this effect subscribing.
    // oxlint-disable-next-line react-doctor/no-pass-live-state-to-parent -- subscribing to the billing store: read it once now, as useSyncExternalStore does, or a reload that landed first is never seen.
    check();
    return unsubscribe;
  }, [formatMessage, onAdded, paid, serverName]);
  // While Stripe confirms the card, read billing again now and then (GET
  // /billing/subscription asks Stripe), in case the webhook is slow; a minute at most.
  const confirming = stage.kind === "paying";
  useEffect(() => {
    if (!confirming) return;
    let reads = 0;
    const timer = window.setInterval(() => {
      reads += 1;
      if (reads >= CONFIRM_POLL_LIMIT) window.clearInterval(timer);
      void loadBilling();
    }, CONFIRM_POLL_MS);
    return () => window.clearInterval(timer);
  }, [confirming, loadBilling]);
  // Waiting on the bank or another card, the owner is in another tab: read again when they're back.
  const waitingElsewhere = stage.kind === "bank" || stage.kind === "declined" || stage.kind === "held";
  useEffect(() => {
    if (!waitingElsewhere) return;
    const readAgain = () => void loadBilling();
    window.addEventListener("focus", readAgain);
    return () => window.removeEventListener("focus", readAgain);
  }, [loadBilling, waitingElsewhere]);

  const commit = useCallback(async () => {
    if (!price) return;
    setCommitting(true);
    setError("");
    if (need.gate) trackPaywallAction(need.gate, "upgrade");
    try {
      const { data } = await api.post<SeatUpdate>("/billing/seat-pack-quantity", {
        seatQuantity: requested,
        previewToken: price.previewToken,
        entry: need.gate ?? need.entry ?? "settings",
      });
      const paidFor = { target: requested, count: add };
      // Read now: Stripe may have confirmed already, and the dialog carries on when billing has the count.
      void loadBilling();
      const held = data.heldPayment;
      if (data.status !== "pending_payment") {
        onPaid?.();
        setStage({ kind: "paying", paid: paidFor });
      } else if (held?.url && held.action === "authenticate") {
        // Most browsers let this through; if not, the bank view's link opens it.
        window.open(held.url, "_blank", "noopener,noreferrer");
        setStage({ kind: "bank", url: held.url, paid: paidFor });
      } else if (held?.url && held.action === "update_payment_method") {
        setStage({ kind: "declined", url: held.url, paid: paidFor });
      } else {
        setStage({ kind: "held", paid: paidFor });
      }
    } catch (err: unknown) {
      setError(billingServerError(err) || formatMessage({ id: "addSeats.failed" }));
      // The token may be spent, expired or out of date: price it again before another try.
      askPriceAgain();
    } finally {
      setCommitting(false);
    }
  }, [add, askPriceAgain, formatMessage, loadBilling, need.entry, need.gate, onPaid, price, requested]);

  const handleCommit = useCallback(() => void commit(), [commit]);
  const heldUrl = stage.kind === "bank" || stage.kind === "declined" ? stage.url : null;
  const openHeldPage = useCallback(() => {
    if (heldUrl) window.open(heldUrl, "_blank", "noopener,noreferrer");
  }, [heldUrl]);
  const removeSeat = useCallback(() => setExtra((count) => Math.max(0, count - 1)), []);
  const addSeat = useCallback(() => setExtra((count) => count + 1), []);
  // Not while the update is on its way to Stripe: it may charge, and this dialog is what carries on.
  const handleOpenChange = useCallback((open: boolean) => {
    if (!open && !committing) onClose();
  }, [committing, onClose]);

  const amount = price ? formatBillingAmount(price.prorationAmount, price.currency, locale) : null;
  const periodEnd = billing?.subscription?.currentPeriodEnd ? new Date(billing.subscription.currentPeriodEnd) : null;
  const annual = billing?.subscription?.billingInterval === "annual";

  let right: ReactNode;
  let action: ReactNode = null;
  if (stage.kind === "paying") {
    right = <PayingView resume={need.resume} />;
  } else if (stage.kind === "bank" || stage.kind === "declined") {
    // The held invoice's Stripe page: the bank's confirmation, or (declined) paying
    // with another card, since the held update can't be sent again. As Upgrade to
    // Pro's "Reopen checkout": a muted link that opens Stripe.
    const declined = stage.kind === "declined";
    right = (
      <BillingWaiting
        testId={`${TEST_ID}-waiting`}
        title={formatMessage({ id: declined ? "addSeats.declinedTitle" : "addSeats.bankTitle" })}
        body={formatMessage({ id: declined ? "addSeats.declinedBody" : "addSeats.bankBody" })}
        failed={declined}
      >
        <TextLink variant="muted" onClick={openHeldPage} data-testid={`${TEST_ID}-${declined ? "declined" : "bank"}`}>
          {formatMessage({ id: declined ? "addSeats.declinedLink" : "addSeats.bankReopen" })}
          <TextLinkExternalIcon label={formatMessage({ id: "common.goesToStripe" })} />
        </TextLink>
      </BillingWaiting>
    );
  } else if (stage.kind === "held") {
    right = <BillingWaiting testId={`${TEST_ID}-waiting`} title={formatMessage({ id: "addSeats.heldTitle" })} body={formatMessage({ id: "addSeats.heldBody" })} />;
  } else {
    right = (
      // The right column scrolls on its own from md, in a raft-ui ScrollArea; below md it is
      // only as tall as its content and the frame's body scrolls (SetupStepFrame).
      <ScrollArea className="md:min-h-0" contentClassName="flex flex-col gap-4 px-6 py-5 sm:px-7">
        {error ? <Banner intent="warning">{error}</Banner> : null}
        {!error && previewError ? (
          <Banner intent="warning">
            {previewError}{" "}
            <TextLink variant="strong" onClick={askPriceAgain} data-testid={`${TEST_ID}-preview-retry`}>
              {formatMessage({ id: "addSeats.previewRetry" })}
            </TextLink>
          </Banner>
        ) : null}
        <div className="flex items-center gap-4">
          <div className="min-w-0 flex-1">
            <p className="text-subhead font-bold text-foreground">{formatMessage({ id: "addSeats.howMany" })}</p>
            <p className="text-footnote text-foreground-muted" data-testid={`${TEST_ID}-room`}>
              <RoomLine total={requested} roomTenths={requested * PRO_AGENT_SEAT_BLOCK_SIZE - usedTenths - need.tenths} />
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="icon-md"
              onClick={removeSeat}
              disabled={committing || extra === 0}
              aria-label={formatMessage({ id: "addSeats.removeSeat" })}
              data-testid={`${TEST_ID}-seat-remove`}
            >
              <Minus size={16} aria-hidden="true" />
            </Button>
            <output className="w-8 text-center text-subhead font-bold tabular-nums text-foreground" aria-live="polite" data-testid={`${TEST_ID}-seats`}>
              {add}
            </output>
            <Button
              type="button"
              variant="outline"
              size="icon-md"
              onClick={addSeat}
              disabled={committing}
              aria-label={formatMessage({ id: "addSeats.addSeat" })}
              data-testid={`${TEST_ID}-seat-add`}
            >
              <Plus size={16} aria-hidden="true" />
            </Button>
          </div>
        </div>
        {/* The note reads as the price's footnote: 8px under the card (Kirby). */}
        <div className="grid gap-2">
          <div className="grid gap-3 rounded-container border border-line-hairline bg-layer-card px-4 py-3" data-testid={`${TEST_ID}-price`}>
            <PriceRow
              label={formatMessage({ id: "addSeats.today" })}
              note={periodEnd ? formatMessage({ id: "addSeats.todayNote" }, { date: formatDate(periodEnd, { month: "long", day: "numeric" }) }) : null}
              value={amount}
              strong
            />
            <Separator />
            <PriceRow
              label={formatMessage({ id: annual ? "addSeats.nextAnnual" : "addSeats.nextMonthly" })}
              note={periodEnd ? formatMessage(
                // A promotion code's discount is already in the price: the note says so.
                { id: price?.promotion && price.discountAmount ? "addSeats.nextNotePromo" : "addSeats.nextNote" },
                {
                  date: formatDate(periodEnd, { month: "long", day: "numeric" }),
                  code: price?.promotion?.code ?? "",
                  amount: price?.discountAmount ? formatBillingAmount(price.discountAmount, price.currency, locale) : "",
                },
              ) : null}
              value={price ? formatBillingAmount(price.recurringAmount, price.currency, locale) : null}
            />
          </div>
          <p className="text-footnote text-foreground-hint">{formatMessage({ id: "addSeats.chargedTo" })}</p>
        </div>
        {promoAllowed ? (
          <PromoField
            open={promo.open}
            input={promo.input}
            applied={promoCode}
            error={promoError}
            disabled={committing}
            onOpen={openPromo}
            onInput={handlePromoInput}
            onApply={applyPromo}
            onRemove={removePromo}
          />
        ) : null}
      </ScrollArea>
    );
    action = (
      <Button
        type="button"
        size="lg"
        variant="primary"
        className="w-full sm:w-auto"
        onClick={handleCommit}
        disabled={!price || committing}
        loading={committing}
        loadingLabel={formatMessage({ id: "addSeats.adding" })}
        data-testid={`${TEST_ID}-commit`}
      >
        {amount
          ? formatMessage({ id: "addSeats.commit" }, { count: add, amount })
          : formatMessage({ id: "addSeats.commitNoPrice" }, { count: add })}
      </Button>
    );
  }

  return (
    <SeatsFrame
      need={need}
      seats={seats}
      humans={billing?.usage?.humans ?? 0}
      agents={billing?.usage?.agents ?? 0}
      right={right}
      action={action}
      onOpenChange={handleOpenChange}
      closeDisabled={committing}
    />
  );
}

/**
 * An admin's or member's right half (design 6/7): adding seats takes an owner,
 * so it sends one a seat request card (POST /actions/seat-requests) for what
 * they were doing, with their reason. The owner adds the seats from the card;
 * invites and a promotion are then done as the owner, an agent or assistant
 * is left for the asker.
 */
function AskSeatsPart({ need, ask, onClose, onSent }: { need: AddSeatsNeed; ask: { purpose: SeatsAddPurpose; usage?: SeatUsage }; onClose: () => void; onSent?: () => void }) {
  const { formatMessage } = useIntl();
  const nav = useAppNavigate();
  const billing = useServerStore((state) => state.billing);
  const ownerState = useOwnerRecipient();
  // null: the server picks the owner (the viewer can't see the server's people).
  const recipient = requestCardOwner(ownerState);
  const [reason, setReason] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const usage: SeatUsage = ask.usage ?? {
    seats: Math.max(0, billing?.capacity?.maxUniversalSeats ?? 0),
    humans: billing?.usage?.humans ?? 0,
    agents: billing?.usage?.agents ?? 0,
  };
  const handleReasonChange = useCallback((event: ChangeEvent<HTMLTextAreaElement>) => setReason(event.currentTarget.value), []);
  const handleOpenChange = useCallback((open: boolean) => {
    if (!open && !sending) onClose();
  }, [onClose, sending]);
  const send = useCallback(async () => {
    if (recipient === undefined) return;
    setSending(true);
    setError("");
    if (need.gate) trackPaywallAction(need.gate, "message_owner");
    try {
      const { data } = await api.post<{ channelId: string }>("/actions/seat-requests", {
        ...(recipient ? { ownerUserId: recipient.userId } : {}),
        purpose: ask.purpose,
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      });
      onClose();
      onSent?.();
      showToast({
        title: recipient
          ? formatMessage({ id: "upgradeDialog.sentToast" }, { owner: ownerName(recipient) })
          : formatMessage({ id: "upgradeDialog.sentToOwnerToast" }),
        description: formatMessage({ id: "addSeats.sentToastDescription" }, purposeCopyValues(ask.purpose)),
        type: "success",
        data: { intent: "success", ...(recipient ? { person: { avatarUrl: recipient.avatarUrl } } : {}) },
        actionProps: {
          children: formatMessage({ id: "upgradeDialog.view" }),
          onClick: () => nav.toDm(data.channelId),
        },
      });
    } catch (err: unknown) {
      setError(billingServerError(err) || formatMessage({ id: "upgradeDialog.sendFailed" }));
      setSending(false);
    }
  }, [ask.purpose, formatMessage, nav, need.gate, onClose, onSent, reason, recipient]);
  const handleSend = useCallback(() => void send(), [send]);

  const right = (
    <div className="flex flex-col gap-3 px-6 py-5 sm:px-7" data-testid={`${TEST_ID}-ask-owner`}>
      {error ? <Banner intent="warning">{error}</Banner> : null}
      <p className="text-callout text-foreground" data-testid={`${TEST_ID}-ask-intro`}>{formatMessage({ id: "addSeats.askIntro" }, purposeCopyValues(ask.purpose))}</p>
      {recipient === null ? null : <OwnerPicker state={ownerState} disabled={sending} testIdPrefix={TEST_ID} />}
      <Field>
        <FieldLabel>{formatMessage({ id: "addSeats.reasonLabel" })}</FieldLabel>
        <Textarea
          value={reason}
          onChange={handleReasonChange}
          rows={3}
          className="resize-none"
          maxLength={SEAT_REQUEST_REASON_MAX_LENGTH}
          placeholder={formatMessage({ id: "addSeats.reasonPlaceholder" })}
          disabled={sending}
          data-testid={`${TEST_ID}-reason`}
        />
      </Field>
    </div>
  );
  const action = recipient !== undefined ? (
    <Button
      type="button"
      size="lg"
      variant="primary"
      className="w-full sm:w-auto"
      onClick={handleSend}
      disabled={sending}
      loading={sending}
      loadingLabel={formatMessage({ id: "upgradeDialog.sending" })}
      data-testid={`${TEST_ID}-send`}
    >
      {recipient
        ? formatMessage({ id: "upgradeDialog.send" }, { owner: ownerName(recipient) })
        : formatMessage({ id: "upgradeDialog.sendToOwner" })}
    </Button>
  ) : null;
  return <SeatsFrame need={need} seats={usage.seats} humans={usage.humans} agents={usage.agents} right={right} action={action} onOpenChange={handleOpenChange} closeDisabled={sending} />;
}

/** Plan & Billing's promotion code: a link until wanted, then the code and Apply; Stripe checks it with the price. */
function PromoField({
  open,
  input,
  applied,
  error,
  disabled,
  onOpen,
  onInput,
  onApply,
  onRemove,
}: {
  open: boolean;
  input: string;
  applied: string;
  error: string;
  disabled: boolean;
  onOpen: () => void;
  onInput: (event: ChangeEvent<HTMLInputElement>) => void;
  onApply: () => void;
  onRemove: () => void;
}) {
  const { formatMessage } = useIntl();
  if (applied) {
    return (
      <p className="text-footnote text-foreground-muted" data-testid={`${TEST_ID}-promo-applied`}>
        {formatMessage({ id: "addSeats.promoUsing" }, { code: applied })}{" "}
        <TextLink variant="muted" onClick={onRemove} data-testid={`${TEST_ID}-promo-remove`}>
          {formatMessage({ id: "addSeats.promoRemove" })}
        </TextLink>
      </p>
    );
  }
  if (!open) {
    return (
      <span className="text-footnote">
        <TextLink variant="muted" onClick={onOpen} data-testid={`${TEST_ID}-promo-open`}>
          {formatMessage({ id: "addSeats.promoAdd" })}
        </TextLink>
      </span>
    );
  }
  return (
    <Field invalid={Boolean(error)}>
      <FieldLabel>{formatMessage({ id: "addSeats.promoLabel" })}</FieldLabel>
      <div className="flex gap-2">
        <Input
          value={input}
          onChange={onInput}
          autoComplete="off"
          // Opened from its link (or after Remove): the field takes the focus, which would otherwise drop to the page.
          autoFocus
          disabled={disabled}
          className="min-w-0 flex-1"
          data-testid={`${TEST_ID}-promo-input`}
        />
        <Button type="button" variant="outline" size="md" onClick={onApply} disabled={disabled || !input.trim()} data-testid={`${TEST_ID}-promo-apply`}>
          {formatMessage({ id: "addSeats.promoApply" })}
        </Button>
      </div>
      {error ? <FieldError match role="alert" data-testid={`${TEST_ID}-promo-error`}>{error}</FieldError> : null}
    </Field>
  );
}
