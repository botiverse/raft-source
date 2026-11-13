import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import { Minus, Plus } from "lucide-react";
import { Button, ScrollArea, Separator, TextLink, TextLinkExternalIcon } from "@botiverse/raft-ui";
import { PRO_AGENT_SEAT_BLOCK_SIZE, seatTenths } from "@botiverse/raft-shared";
import type { PrepaidSeatsQuote } from "@botiverse/raft-shared";
import api from "../../api/client";
import { trackPaywallAction } from "../../analytics/paywall";
import { useBillingReturnRefresh } from "../../hooks/useBillingReturnRefresh";
import { useServerStore } from "../../store/serverStore";
import { checkoutErrorMessage } from "../../utils/proCheckout";
import { openUpgradeDialog } from "../../store/upgradeDialogStore";
import { shareableWebUrl } from "../../utils/desktopShell";
import { formatBillingAmount } from "../../utils/formatBillingAmount";
import Banner from "../ui/Banner";
import LeavingRaftMark from "../ui/LeavingRaftMark";
import { showToast } from "../toastBridge";
import BillingWaiting from "./BillingWaiting";
import { billingServerError } from "./billingServerError";
import { PriceRow, RoomLine, SeatsFrame } from "./AddSeatsParts";
import type { AddSeatsNeed } from "./AddSeatsDialog";

const TEST_ID = "add-seats-dialog";
/** Ask for the price once the count settles, not on every click of +. */
const QUOTE_SETTLE_MS = 300;
/** When the server doesn't say: Stripe's shortest Checkout, which the seats one uses. */
const CHECKOUT_LIFETIME_MS = 30 * 60 * 1000;

interface QuoteState {
  seats: number;
  data: PrepaidSeatsQuote | null;
  error: string;
}

type Stage =
  | { kind: "choose" }
  | { kind: "paying"; url: string; expiresAt: number; target: number; count: number };

/**
 * The owner's half of the add-seats dialog on prepaid Pro (task #19, paid
 * once with Alipay; docs/billing/prepaid-pro.md): seats for the days left
 * until the paid time ends, priced by the server, paid once in an Alipay
 * Checkout. Checkout opens in a new tab so the action waiting on the seats
 * (an invite, a new agent) stays here, and the dialog carries on once the
 * webhook has added them. In the grace days seats come with a renewal.
 */
export function PrepaidSeatsPart({
  need,
  onClose,
  onAdded,
}: {
  need: AddSeatsNeed;
  onClose: () => void;
  onAdded: () => void;
}) {
  const { formatMessage, formatDate, locale } = useIntl();
  const billing = useServerStore((state) => state.billing);
  const server = useServerStore((state) => state.current);
  const noteCheckoutOpened = useBillingReturnRefresh();

  const seats = Math.max(0, billing?.capacity?.maxUniversalSeats ?? 0);
  const usedTenths = seatTenths(billing?.usage?.humans ?? 0, billing?.usage?.agents ?? 0);
  const minimumAdd = Math.max(1, Math.ceil((usedTenths + need.tenths) / PRO_AGENT_SEAT_BLOCK_SIZE) - seats);
  const [extra, setExtra] = useState(0);
  const add = minimumAdd + extra;
  const requested = seats + add;
  const prepaid = billing?.prepaid ?? null;

  const [stage, setStage] = useState<Stage>({ kind: "choose" });
  const paying = stage.kind === "paying";
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");
  const [quote, setQuote] = useState<QuoteState>({ seats: 0, data: null, error: "" });
  const [quoteRound, setQuoteRound] = useState(0);
  const [expired, setExpired] = useState(false);

  // The server's price for this count: an outside system, asked again when the count settles.
  useEffect(() => {
    if (paying || prepaid?.inGrace) return;
    let ignore = false;
    const timer = window.setTimeout(() => {
      api.get<PrepaidSeatsQuote>("/billing/prepaid/seats/quote", { params: { seatQuantity: add } })
        .then(({ data }) => {
          if (!ignore) setQuote({ seats: add, data, error: "" });
        })
        .catch((err: unknown) => {
          if (!ignore) setQuote({ seats: add, data: null, error: checkoutErrorMessage(err, formatMessage) || billingServerError(err) || formatMessage({ id: "addSeats.previewFailed" }) });
        });
    }, QUOTE_SETTLE_MS);
    return () => {
      ignore = true;
      window.clearTimeout(timer);
    };
  }, [add, formatMessage, paying, prepaid?.inGrace, quoteRound]);
  const askPriceAgain = useCallback(() => setQuoteRound((round) => round + 1), []);
  const current = quote.seats === add ? quote : null;
  const offered = current?.data && current.data.unavailableReason === null ? current.data : null;
  const unavailable = current?.data?.unavailableReason ?? null;

  // Paid in the other tab: the seats count once the webhook lands (server:plan-updated
  // reloads billing; a return to this window reads it again). Carry on once, as the card path does.
  const announced = useRef(false);
  useEffect(() => {
    if (stage.kind !== "paying") return;
    const { target, count } = stage;
    const check = () => {
      const now = useServerStore.getState().billing?.capacity?.maxUniversalSeats ?? 0;
      if (announced.current || now < target) return;
      announced.current = true;
      showToast({
        title: formatMessage({ id: "addSeats.addedToast" }, { count }),
        description: formatMessage({ id: "addSeats.addedToastDescription" }, { server: server?.name ?? "", seats: now }),
        type: "success",
        data: { intent: "success" },
      });
      onAdded();
    };
    const unsubscribe = useServerStore.subscribe(check);
    // oxlint-disable-next-line react-doctor/no-pass-live-state-to-parent -- subscribing to the billing store: read it once now, as useSyncExternalStore does, or a reload that landed first is never seen.
    check();
    return unsubscribe;
  }, [formatMessage, onAdded, server?.name, stage]);

  const pay = useCallback(async () => {
    if (!offered || !server) return;
    setStarting(true);
    setError("");
    if (need.gate) trackPaywallAction(need.gate, "upgrade");
    try {
      // Back from Alipay, the new tab lands on Plan & Billing, where the seats show.
      const returnUrl = shareableWebUrl(undefined, `${window.location.origin}/s/${server.slug}/settings/billing`);
      const { data } = await api.post<{ url: string; expiresAt?: string }>("/billing/prepaid/seats/checkout", {
        seatQuantity: add,
        successUrl: returnUrl,
        cancelUrl: returnUrl,
        entry: need.gate ?? need.entry ?? "settings",
      });
      noteCheckoutOpened();
      // Most browsers let this through; if not, the waiting view's link opens it.
      window.open(data.url, "_blank", "noopener,noreferrer");
      // The price is for now: the Checkout stops taking payment after about half an hour.
      const expiresAt = Date.parse(data.expiresAt ?? "") || Date.now() + CHECKOUT_LIFETIME_MS;
      setExpired(false);
      setStage({ kind: "paying", url: data.url, expiresAt, target: requested, count: add });
    } catch (err: unknown) {
      setError(checkoutErrorMessage(err, formatMessage) || billingServerError(err) || formatMessage({ id: "prepaidSeats.failed" }));
      askPriceAgain();
    } finally {
      setStarting(false);
    }
  }, [add, askPriceAgain, formatMessage, need.entry, need.gate, noteCheckoutOpened, offered, requested, server]);
  const handlePay = useCallback(() => void pay(), [pay]);
  // A timer, because the Checkout's lifetime is Stripe's, not something this dialog renders.
  const expiresAt = stage.kind === "paying" ? stage.expiresAt : null;
  useEffect(() => {
    if (expiresAt === null) return;
    const timer = window.setTimeout(() => setExpired(true), Math.max(0, expiresAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [expiresAt]);
  // Not paid in time (or paid and refunded, or cancelled): price the seats again for now.
  const priceAgain = useCallback(() => {
    setExpired(false);
    setStage({ kind: "choose" });
    setQuoteRound((round) => round + 1);
  }, []);
  const checkoutUrl = stage.kind === "paying" ? stage.url : null;
  const reopenCheckout = useCallback(() => {
    if (checkoutUrl) window.open(checkoutUrl, "_blank", "noopener,noreferrer");
  }, [checkoutUrl]);
  const renew = useCallback(() => {
    if (!server) return;
    onClose();
    // The upgrade dialog sees prepaid time and renews it, seats included.
    openUpgradeDialog("general", { serverId: server.id, unprompted: true, settingsEntry: need.entry });
  }, [need.entry, onClose, server]);
  const removeSeat = useCallback(() => setExtra((count) => Math.max(0, count - 1)), []);
  const addSeat = useCallback(() => setExtra((count) => count + 1), []);
  const handleOpenChange = useCallback((open: boolean) => {
    if (!open && !starting) onClose();
  }, [onClose, starting]);

  const amount = offered ? formatBillingAmount(offered.amountTotal, offered.currency, locale) : null;
  const unit = offered ? formatBillingAmount(offered.unitAmount, offered.currency, locale) : null;
  const endLabel = prepaid ? formatDate(prepaid.endsAt, { month: "long", day: "numeric", year: "numeric" }) : "";

  let right: ReactNode;
  let action: ReactNode = null;
  if (stage.kind === "paying") {
    right = expired ? (
      <BillingWaiting
        testId={`${TEST_ID}-waiting`}
        title={formatMessage({ id: "prepaidSeats.expiredTitle" })}
        body={formatMessage({ id: "prepaidSeats.expiredBody" })}
        failed
      >
        <TextLink variant="muted" onClick={priceAgain} data-testid={`${TEST_ID}-prepaid-price-again`}>
          {formatMessage({ id: "prepaidSeats.priceAgain" })}
        </TextLink>
      </BillingWaiting>
    ) : (
      <BillingWaiting
        testId={`${TEST_ID}-waiting`}
        title={formatMessage({ id: "prepaidSeats.payingTitle" })}
        body={formatMessage({ id: "prepaidSeats.payingBody" }, { resume: need.resume })}
      >
        <TextLink variant="muted" onClick={reopenCheckout} data-testid={`${TEST_ID}-prepaid-reopen`}>
          {formatMessage({ id: "prepaidSeats.reopen" })}
          <TextLinkExternalIcon label={formatMessage({ id: "common.goesToStripe" })} />
        </TextLink>
      </BillingWaiting>
    );
  } else if (prepaid?.inGrace || unavailable === "in_grace") {
    // After the paid end, seats come with a renewal (chosen in the upgrade dialog).
    right = (
      <div className="flex flex-col gap-4 px-6 py-5 sm:px-7">
        <Banner intent="warning" data-testid={`${TEST_ID}-prepaid-grace`}>
          {formatMessage({ id: "prepaidSeats.grace" }, { date: endLabel })}
        </Banner>
      </div>
    );
    action = (
      <Button type="button" size="lg" variant="primary" className="w-full sm:w-auto" onClick={renew} data-testid={`${TEST_ID}-prepaid-renew`}>
        {formatMessage({ id: "planBilling.prepaid.renew" })}
      </Button>
    );
  } else {
    right = (
      <ScrollArea className="md:min-h-0" contentClassName="flex flex-col gap-4 px-6 py-5 sm:px-7">
        {error ? <Banner intent="warning">{error}</Banner> : null}
        {!error && current?.error ? (
          <Banner intent="warning">
            {current.error}{" "}
            <TextLink variant="strong" onClick={askPriceAgain} data-testid={`${TEST_ID}-preview-retry`}>
              {formatMessage({ id: "addSeats.previewRetry" })}
            </TextLink>
          </Banner>
        ) : null}
        {!error && unavailable ? (
          <Banner intent="warning" data-testid={`${TEST_ID}-prepaid-unavailable`}>{formatMessage({ id: "prepaidSeats.unavailable" })}</Banner>
        ) : null}
        <div className="flex items-center gap-4">
          <div className="min-w-0 flex-1">
            <p className="text-subhead font-bold text-foreground">{formatMessage({ id: "addSeats.howMany" })}</p>
            <p className="text-footnote text-foreground-muted" data-testid={`${TEST_ID}-room`}>
              <RoomLine total={requested} roomTenths={requested * PRO_AGENT_SEAT_BLOCK_SIZE - usedTenths - need.tenths} />
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button type="button" variant="outline" size="icon-md" onClick={removeSeat} disabled={starting || extra === 0}
              aria-label={formatMessage({ id: "addSeats.removeSeat" })} data-testid={`${TEST_ID}-seat-remove`}>
              <Minus size={16} aria-hidden="true" />
            </Button>
            <output className="w-8 text-center text-subhead font-bold tabular-nums text-foreground" aria-live="polite" data-testid={`${TEST_ID}-seats`}>
              {add}
            </output>
            <Button type="button" variant="outline" size="icon-md" onClick={addSeat} disabled={starting}
              aria-label={formatMessage({ id: "addSeats.addSeat" })} data-testid={`${TEST_ID}-seat-add`}>
              <Plus size={16} aria-hidden="true" />
            </Button>
          </div>
        </div>
        <div className="grid gap-2">
          <div className="grid gap-3 rounded-container border border-line-hairline bg-layer-card px-4 py-3" data-testid={`${TEST_ID}-price`}>
            <PriceRow
              label={formatMessage({ id: "prepaidSeats.perSeat" })}
              note={offered ? formatMessage({ id: "prepaidSeats.perSeatNote" }, { days: offered.days, date: endLabel }) : null}
              value={unit}
            />
            <Separator />
            <PriceRow
              label={formatMessage({ id: "prepaidSeats.total" }, { count: add })}
              note={offered?.minimumApplied ? formatMessage({ id: "prepaidSeats.minimumNote" }, { amount: formatBillingAmount(offered.amountTotal, offered.currency, locale) }) : null}
              value={amount ? formatMessage({ id: "prepaidSeats.totalOnce" }, { amount }) : null}
              strong
            />
          </div>
          <p className="text-footnote text-foreground-hint">{formatMessage({ id: "prepaidSeats.note" }, { date: endLabel })}</p>
        </div>
      </ScrollArea>
    );
    action = (
      <Button
        type="button"
        size="lg"
        variant="primary"
        className="w-full sm:w-auto"
        onClick={handlePay}
        disabled={!offered || starting}
        loading={starting}
        loadingLabel={formatMessage({ id: "prepaidSeats.opening" })}
        data-testid={`${TEST_ID}-commit`}
      >
        {amount ? formatMessage({ id: "prepaidSeats.commit" }, { amount }) : formatMessage({ id: "prepaidSeats.commitNoPrice" })}
        <LeavingRaftMark data-icon="inline-end" destination="stripe" />
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
      closeDisabled={starting}
    />
  );
}
