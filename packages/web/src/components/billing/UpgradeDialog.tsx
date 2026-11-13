import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, ReactNode } from "react";
import { useIntl } from "react-intl";
import type { IntlShape } from "react-intl";
import { useLocation, useNavigate } from "react-router-dom";
import {
  Button,
  Dialog,
  DialogClose,
  Field,
  FieldError,
  Textarea,
  TextLink,
  TextLinkExternalIcon,
} from "@botiverse/raft-ui";
import LeavingRaftMark, { opensInNewTabAriaLabel } from "../ui/LeavingRaftMark";
import {
  AGENT_UPGRADE_CARD_GATES,
  BILLING_ENTRIES,
  CHECKOUT_OPENED_FROM,
  PAYWALL_SURFACES,
  PLAN_UPGRADE_REASON_MAX_LENGTH,
} from "@botiverse/raft-shared";
import type { AgentUpgradeCardGate, BillingEntry, PaywallSurface, PrepaidOffer, PrepaidOfferPeriod } from "@botiverse/raft-shared";
import { useAppNavigate } from "../../hooks/useAppNavigate";
import { useServerPermissions } from "../../hooks/useServerPermissions";
import { useChannelStore } from "../../store/channelStore";
import { useMessageStore } from "../../store/messageStore";
import { useServerStore } from "../../store/serverStore";
import type { BillingInfo } from "../../store/serverStore";
import BillingWaiting from "./BillingWaiting";
import { OwnerPicker, ownerName, requestCardOwner, useOwnerRecipient } from "./OwnerPicker";
import api from "../../api/client";
import { PRO_PREPAID_FEATURE_FLAG_KEY, PRO_SEAT_ADD_FEATURE_FLAG_KEY, useServerFeatureFlag } from "../../store/serverFeatureFlags";
import { isUpgradeGate, useUpgradeDialogStore } from "../../store/upgradeDialogStore";
import { formatUploadSize } from "../../utils/attachmentLimitPresentation";
import { monthlyUploadResetsAt, readMonthlyUploadQuota } from "../../utils/monthlyUploadQuota";
import { MONTHLY_UPLOAD_USED_UP_BELOW_BYTES } from "../../store/monthlyUploadQuotaStore";
import type { MonthlyUploadQuota } from "../../utils/monthlyUploadQuota";
import type { ExternalLimitContext, UpgradeDialogSource, UpgradeDialogStage, UpgradeGate, UploadLimitContext } from "../../store/upgradeDialogStore";
import { shareableWebUrl } from "../../utils/desktopShell";
import { useBillingReturnRefresh } from "../../hooks/useBillingReturnRefresh";
import { readAlipayHintSources, showsAlipayOption } from "../../utils/alipayHint";
import { checkoutErrorMessage, fetchPrepaidOffer, startPrepaidCheckout, startProCheckout } from "../../utils/proCheckout";
import { isPaywallGate, trackPaywallAction } from "../../analytics/paywall";
import { trackPlanBillingDialogClosed } from "../../analytics/planBilling";
import { FramedDialogContent } from "../ui/NarrowDialog";
import SetupStepFrame from "../onboarding/SetupStepFrame";
import Banner from "../ui/Banner";
import { ProCheckoutChoices, ProOfferPanel, useProCheckoutDraft } from "./ProOffer";
import type { CheckoutPayment, ProHighlightKey } from "./ProOffer";
import { showToast } from "../toastBridge";
import { emitActionCardEvent } from "../actions/actionCardCommon";
import { billingServerError } from "./billingServerError";
import { useTimeFormatter } from "../../hooks/useTimeFormatter";
import { askOwnerPrefill, externalLimitCopy, GATE_COPY, gateValues, historyLimitHint, UPGRADE_CANCELED_PARAM as CANCELED_PARAM, UPGRADE_ENTRY_PARAM as ENTRY_PARAM, UPGRADE_RENEW_FROM_PARAM as RENEW_FROM_PARAM, UPGRADE_RETURN_PARAM, UPGRADE_SERVER_PARAM as SERVER_PARAM, UPGRADE_SOURCE_PARAM as SOURCE_PARAM, UPGRADE_SURFACE_PARAM as SURFACE_PARAM, upgradeGateCopy } from "./upgradeGateCopy";

/**
 * The upgrade dialog every Free paywall's Upgrade opens, in place (cindyz, task #7;
 * design: raft-artifacts upgrade-dialog-drafts v6). It is the onboarding Pro step's frame
 * and offer; only the title, the first benefit and the message to the owner follow the
 * paywall someone hit. Owners pay right here. Everyone else sends an owner a message.
 */

const PRICING_URL = "https://raft.build/pricing";
const TEST_ID = "upgrade-dialog";
const TITLE_ID = "upgrade-dialog-title";
/** After this long without the plan turning Pro, say the payment may still land later. */
const CONFIRMING_SLOW_MS = 30_000;

/**
 * The Pro benefit listed first for each gate. A gate with no Pro benefit of its
 * own in the offer (a Pro theme) moves none up; `general` keeps the offer's own
 * order. The external channel gates lead with unlimited external channels (cindyz).
 */
const GATE_HIGHLIGHT: Record<UpgradeGate, ProHighlightKey | undefined> = {
  history_30d: "history",
  upload_monthly_quota: "files",
  upload_file_size: "files",
  joint_channel_free_cap: "joint",
  joint_channel_host_limit: "joint",
  joint_channel_over_limit: "joint",
  joint_channel_read_only: "joint",
  agent_migration: "migration",
  plan_downgraded: "history",
  pro_theme: undefined,
  external_channel_free_limit: "joint",
  external_channel_frozen: "joint",
  general: undefined,
};

/**
 * The line under the title when an upload limit opened the dialog: which file
 * and how big, or how much of the month is left and when it resets (cindyz,
 * 2026-10-28). The gate's own line otherwise.
 */
function uploadLimitHint(
  formatMessage: IntlShape["formatMessage"],
  formatDate: IntlShape["formatDate"],
  context: UploadLimitContext,
  serverName: string,
): string {
  const values = gateValues(serverName);
  const [only] = context.files.length === 1 ? context.files : [];
  if (context.kind === "file_size") {
    return only
      ? formatMessage({ id: "upgradeDialog.fileSize.hintFile" }, { ...values, file: only.name, size: formatUploadSize(only.size, formatMessage) })
      : formatMessage({ id: "upgradeDialog.fileSize.hintFiles" }, { ...values, count: context.files.length });
  }
  const quota = {
    ...values,
    monthly: formatUploadSize(context.quota.limitBytes, formatMessage),
    remaining: formatUploadSize(context.quota.remainingBytes, formatMessage),
    // The quota counts UTC months, so its reset is a UTC date.
    date: formatDate(monthlyUploadResetsAt(context.quota), { month: "short", day: "numeric", timeZone: "UTC" }),
  };
  if (context.files.length === 0) return formatMessage({ id: "upgradeDialog.uploadQuota.hintUsedUp" }, quota);
  return only
    ? formatMessage({ id: "upgradeDialog.uploadQuota.hintFile" }, { ...quota, file: only.name, size: formatUploadSize(only.size, formatMessage) })
    : formatMessage({ id: "upgradeDialog.uploadQuota.hintFiles" }, { ...quota, count: context.files.length });
}

/** The server's owners, its creator first (OwnerPicker.tsx). */
export { serverOwners as upgradeOwners } from "./OwnerPicker";

/**
 * This page with the paywall Stripe should report back, paid or (`canceled`)
 * not, and what the dialog was opened with; `server`, the server paid for when
 * it isn't the current one (a page outside the app).
 */
export function upgradeReturnUrl(
  pageUrl: string,
  gate: UpgradeGate,
  canceled: boolean,
  { source, settingsEntry, renewFrom, surface, server }: { source?: UpgradeDialogSource; settingsEntry?: BillingEntry; renewFrom?: string; surface?: PaywallSurface; server?: string } = {},
): string {
  const url = new URL(pageUrl);
  if (renewFrom) url.searchParams.set(RENEW_FROM_PARAM, renewFrom);
  else url.searchParams.delete(RENEW_FROM_PARAM);
  url.searchParams.set(UPGRADE_RETURN_PARAM, gate);
  if (canceled) url.searchParams.set(CANCELED_PARAM, "1");
  else url.searchParams.delete(CANCELED_PARAM);
  if (source) url.searchParams.set(SOURCE_PARAM, source);
  else url.searchParams.delete(SOURCE_PARAM);
  if (settingsEntry) url.searchParams.set(ENTRY_PARAM, settingsEntry);
  else url.searchParams.delete(ENTRY_PARAM);
  if (surface) url.searchParams.set(SURFACE_PARAM, surface);
  else url.searchParams.delete(SURFACE_PARAM);
  if (server) url.searchParams.set(SERVER_PARAM, server);
  else url.searchParams.delete(SERVER_PARAM);
  return url.toString();
}

function readUpgradeSource(value: string | null): UpgradeDialogSource | undefined {
  return (CHECKOUT_OPENED_FROM as readonly string[]).includes(value ?? "") ? value as UpgradeDialogSource : undefined;
}

function readSettingsEntry(value: string | null): BillingEntry | undefined {
  return (BILLING_ENTRIES as readonly string[]).includes(value ?? "") ? value as BillingEntry : undefined;
}

function readSurface(value: string | null): PaywallSurface | undefined {
  return (PAYWALL_SURFACES as readonly string[]).includes(value ?? "") ? value as PaywallSurface : undefined;
}

function isFreePlan(plan: string | undefined): boolean {
  return !plan || plan === "free";
}

function OwnerPart({
  gate,
  stage,
  serverName,
  source,
  surface,
  settingsEntry,
  target,
}: {
  gate: UpgradeGate;
  stage: UpgradeDialogStage;
  serverName: string;
  source?: UpgradeDialogSource;
  /** Where the paywall that opened it was met: both checkouts carry it to the server's events. */
  surface?: PaywallSurface;
  settingsEntry?: BillingEntry;
  /**
   * A server other than the current one, paid for from a page outside the app
   * (ServerUpgradeDialog): its id and the billing that page read. Stripe's
   * return names it. Absent: the current server.
   */
  target?: { id: string; billing: BillingInfo | null };
}) {
  const { formatMessage, locale } = useIntl();
  const current = useServerStore((state) => state.current);
  const currentBilling = useServerStore((state) => state.billing);
  const serverId = target ? target.id : current?.id;
  const billing = target ? target.billing : currentBilling;
  const setStage = useUpgradeDialogStore((state) => state.setStage);
  const markRenewal = useUpgradeDialogStore((state) => state.markRenewal);
  // The one place that tells a renewal: a prepaid server, however the dialog opened.
  const renewing = billing?.source === "prepaid";
  const renewFrom = renewing ? billing?.prepaid?.endsAt ?? undefined : undefined;
  // Prepaid Pro (task #19): when the flag is on and Stripe has the prices, a link under
  // the total offers Alipay to likely Chinese readers; a prepaid server renews with
  // Alipay only (no subscription on top of it), whoever is looking.
  const prepaidFlag = useServerFeatureFlag(PRO_PREPAID_FEATURE_FLAG_KEY, target ? { serverId: target.id } : undefined);
  const prepaidEnabled = prepaidFlag.enabled;
  const alipayHinted = useMemo(() => showsAlipayOption(readAlipayHintSources(locale)), [locale]);
  const offersPrepaid = prepaidEnabled && (renewing || alipayHinted);
  const [prepaidOffer, setPrepaidOffer] = useState<PrepaidOffer | null>(null);
  const [prepaidOfferFailed, setPrepaidOfferFailed] = useState(false);
  useEffect(() => {
    if (!offersPrepaid || !serverId) return;
    let live = true;
    fetchPrepaidOffer(serverId).then((offer) => { if (live) setPrepaidOffer(offer); }).catch(() => { if (live) setPrepaidOfferFailed(true); });
    return () => { live = false; };
  }, [offersPrepaid, serverId]);
  // Until the flag is known a renewal shows its loading state, not "isn't available".
  const draft = useProCheckoutDraft({ offer: offersPrepaid ? prepaidOffer : null, only: renewing, failed: (prepaidFlag.resolved && !offersPrepaid) || prepaidOfferFailed }, target);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // An error belongs to the way of paying that hit it: switching away hides it.
  const [errorPayment, setErrorPayment] = useState<CheckoutPayment>("card");
  const [checkoutUrl, setCheckoutUrl] = useState<string | null>(null);
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    if (stage !== "confirming") return;
    const timer = window.setTimeout(() => setSlow(true), CONFIRMING_SLOW_MS);
    return () => window.clearTimeout(timer);
  }, [stage]);

  // Stripe leaves the window (Raft Desktop): refetch billing on every return.
  const noteStripeOpened = useBillingReturnRefresh();
  const checkout = useCallback(async () => {
    if (!draft.ready) return;
    setError("");
    setErrorPayment(draft.payment);
    // Paying once never falls back to a subscription.
    const prepaidServerId = draft.payment === "alipay" ? serverId : undefined;
    if (draft.payment === "alipay" && !prepaidServerId) {
      setError(formatMessage({ id: "upgradeDialog.checkoutFailed" }));
      return;
    }
    setBusy(true);
    const page = shareableWebUrl();
    const returnServer = target?.id;
    let url: string;
    try {
      url = prepaidServerId ? await startPrepaidCheckout({
        months: draft.months,
        seatQuantity: draft.seats,
        defaultSeatQuantity: draft.defaultSeats,
        returnUrl: upgradeReturnUrl(page, gate, false, { source, settingsEntry, renewFrom, surface, server: returnServer }),
        cancelUrl: upgradeReturnUrl(page, gate, true, { source, settingsEntry, renewFrom, surface, server: returnServer }),
        serverId: prepaidServerId,
        billingEntry: settingsEntry ?? gate,
        openedFrom: source,
        surface,
      }) : await startProCheckout({
        // The server's billing_checkout_* events name the paywall itself, or
        // what opened Plan & Billing when its Upgrade to Pro opened this.
        ...(settingsEntry ? { entry: "settings" as const, billingEntry: settingsEntry } : { entry: "paywall_panel" as const, billingEntry: gate }),
        billingInterval: draft.billingInterval,
        seatQuantity: draft.seats,
        defaultSeatQuantity: draft.minimumSeats,
        returnUrl: upgradeReturnUrl(page, gate, false, { source, settingsEntry, surface, server: returnServer }),
        cancelUrl: upgradeReturnUrl(page, gate, true, { source, settingsEntry, surface, server: returnServer }),
        serverId,
        openedFrom: source,
        surface,
      });
    } catch (checkoutError) {
      setError(checkoutErrorMessage(checkoutError, formatMessage) ?? formatMessage({ id: "upgradeDialog.checkoutFailed" }));
      setBusy(false);
      return;
    }
    // Closed (× or Esc) while the session was being created: don't leave for Stripe.
    if (!useUpgradeDialogStore.getState().request) return;
    if (settingsEntry) trackPlanBillingDialogClosed("upgrade", "completed");
    setCheckoutUrl(url);
    noteStripeOpened();
    // A browser leaves for Stripe in this tab; Raft Desktop's shell opens it in
    // the system browser and the page stays. Either way, wait for the plan
    // here (server:plan-updated, or the return refetch).
    window.location.href = url;
    setBusy(false);
    // The server is Pro already: the renewal is paid when its end moves past this.
    if (renewFrom) markRenewal(renewFrom);
    setStage("paying");
  }, [draft.billingInterval, draft.defaultSeats, draft.minimumSeats, draft.months, draft.payment, draft.ready, draft.seats, formatMessage, gate, markRenewal, noteStripeOpened, renewFrom, serverId, setStage, settingsEntry, source, surface, target?.id]);
  const handleCheckout = useCallback(() => {
    void checkout();
  }, [checkout]);
  const reopenCheckout = useCallback(() => {
    if (checkoutUrl) window.location.href = checkoutUrl;
  }, [checkoutUrl]);

  let right: ReactNode;
  let action: ReactNode = null;
  if (stage === "paying") {
    right = (
      <BillingWaiting
        testId={`${TEST_ID}-waiting`}
        title={formatMessage({ id: "upgradeDialog.payingTitle" })}
        body={formatMessage({ id: renewing ? "upgradeDialog.renew.payingBody" : "upgradeDialog.payingBody" }, { server: serverName })}
      >
        {checkoutUrl ? (
          <TextLink variant="muted" onClick={reopenCheckout} data-testid={`${TEST_ID}-reopen`}>
            {formatMessage({ id: "upgradeDialog.reopen" })}
            <TextLinkExternalIcon label={formatMessage({ id: "common.goesToStripe" })} />
          </TextLink>
        ) : null}
      </BillingWaiting>
    );
  } else if (stage === "confirming") {
    right = (
      <BillingWaiting
        testId={`${TEST_ID}-waiting`}
        title={formatMessage({ id: "upgradeDialog.confirmingTitle" })}
        body={formatMessage({ id: slow ? (renewing ? "upgradeDialog.renew.confirmingSlow" : "upgradeDialog.confirmingSlow") : "upgradeDialog.confirmingBody" }, { server: serverName })}
      />
    );
  } else {
    right = <ProCheckoutChoices draft={draft} busy={busy} error={errorPayment === draft.payment ? error : ""} testIdPrefix={TEST_ID} />;
    action = (
      <Button
        type="button"
        size="lg"
        variant="primary"
        className="w-full sm:w-auto"
        onClick={handleCheckout}
        disabled={busy || !draft.ready}
        loading={busy}
        loadingLabel={formatMessage({ id: "layout.onboarding.opening" })}
        data-testid={`${TEST_ID}-checkout`}
      >
        {formatMessage({ id: draft.payment === "alipay" ? "prepaidPro.payWithAlipay" : "billing.upgradeToPro" })}
        <LeavingRaftMark data-icon="inline-end" destination="stripe" />
      </Button>
    );
  }
  return (
    <DialogFrame
      gate={gate}
      serverName={serverName}
      billingInterval={draft.billingInterval}
      prepaidPeriod={draft.payment === "alipay" ? draft.period : null}
      pricePending={draft.payment === "alipay" && !draft.period}
      renewUntil={renewing ? billing?.prepaid?.endsAt ?? null : null}
      renewInGrace={renewing && billing?.prepaid?.inGrace === true}
      action={action}
    >
      {right}
    </DialogFrame>
  );
}

/** The gates a plan:upgrade card can name (not pro_theme or plan_downgraded). */
function isAgentUpgradeCardGate(gate: UpgradeGate): gate is AgentUpgradeCardGate {
  return (AGENT_UPGRADE_CARD_GATES as readonly string[]).includes(gate);
}

function AskOwnerPart({ gate, serverName, source, surface, settingsEntry, externalContext }: { gate: UpgradeGate; serverName: string; source?: UpgradeDialogSource; surface?: PaywallSurface; settingsEntry?: BillingEntry; externalContext?: ExternalLimitContext }) {
  const { formatMessage } = useIntl();
  const nav = useAppNavigate();
  const openUserDM = useChannelStore((state) => state.openUserDM);
  const sendMessage = useMessageStore((state) => state.sendMessage);
  const close = useUpgradeDialogStore((state) => state.close);
  const ownerState = useOwnerRecipient();
  // With pro_seat_add on, the request is a card the owner acts on (the same
  // plan:upgrade card an agent offers Pro with), not a plain message.
  const asCard = useServerFeatureFlag(PRO_SEAT_ADD_FEATURE_FLAG_KEY).enabled;
  // A card's owner may be the server's to pick (null: the viewer can't see
  // the server's people); a plain message needs one picked.
  const recipient = asCard ? requestCardOwner(ownerState) : ownerState.recipient;
  // Within a request card's limit, so it can be sent as written (a long server
  // name is cut short). Also for a plain message: the flag may resolve after this runs.
  const [text, setText] = useState(() => askOwnerPrefill(formatMessage, gate, serverName, PLAN_UPGRADE_REASON_MAX_LENGTH, externalContext));
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  // One id per message, so a retry after an unclear failure cannot post it twice.
  const randomIdRef = useRef(crypto.randomUUID());

  const handleTextChange = useCallback((event: ChangeEvent<HTMLTextAreaElement>) => {
    setText(event.currentTarget.value);
    randomIdRef.current = crypto.randomUUID();
  }, []);

  const send = useCallback(async () => {
    if (recipient === undefined || !text.trim()) return;
    setSending(true);
    setError("");
    try {
      let dmId: string;
      if (asCard || !recipient) {
        const { data } = await api.post<{ channelId: string }>("/actions/upgrade-requests", {
          ...(recipient ? { ownerUserId: recipient.userId } : {}),
          reason: text.trim(),
          ...(isAgentUpgradeCardGate(gate) ? { gate } : {}),
        });
        dmId = data.channelId;
      } else {
        const dm = await openUserDM(recipient.userId);
        await sendMessage(dm.id, text.trim(), undefined, undefined, undefined, randomIdRef.current);
        dmId = dm.id;
      }
      // A paywall's dialog: the person asked an owner (an agent card's dialog sends nothing).
      if (!source && isPaywallGate(gate)) trackPaywallAction(gate, "message_owner", surface);
      // An admin on Plan & Billing: asking an owner is how they finish.
      if (settingsEntry) trackPlanBillingDialogClosed("upgrade", "completed");
      close();
      showToast({
        title: recipient
          ? formatMessage({ id: "upgradeDialog.sentToast" }, { owner: ownerName(recipient) })
          : formatMessage({ id: "upgradeDialog.sentToOwnerToast" }),
        type: "success",
        data: {
          intent: "success",
          ...(recipient ? { person: { avatarUrl: recipient.avatarUrl } } : {}),
        },
        actionProps: {
          children: formatMessage({ id: "upgradeDialog.view" }),
          onClick: () => nav.toDm(dmId),
        },
      });
    } catch (err: unknown) {
      // The card's own rules (its reason) answer in their words.
      const serverError = billingServerError(err);
      setError(asCard && serverError ? serverError : formatMessage({ id: "upgradeDialog.sendFailed" }));
      setSending(false);
    }
  }, [asCard, close, formatMessage, gate, nav, openUserDM, recipient, sendMessage, settingsEntry, source, surface, text]);
  // A card's reason holds one sentence: text over its limit can't be sent as is
  // (typed before the request turned into a card; the prefill fits).
  const tooLong = asCard && Array.from(text.trim()).length > PLAN_UPGRADE_REASON_MAX_LENGTH;
  const handleSend = useCallback(() => {
    void send();
  }, [send]);

  const action = recipient !== undefined ? (
    <Button
      type="button"
      size="lg"
      variant="primary"
      className="w-full sm:w-auto"
      onClick={handleSend}
      disabled={sending || !text.trim() || tooLong}
      loading={sending}
      loadingLabel={formatMessage({ id: "upgradeDialog.sending" })}
      data-testid={`${TEST_ID}-send`}
    >
      {recipient
        ? formatMessage({ id: "upgradeDialog.send" }, { owner: ownerName(recipient) })
        : formatMessage({ id: "upgradeDialog.sendToOwner" })}
    </Button>
  ) : null;

  return (
    <DialogFrame gate={gate} serverName={serverName} action={action}>
      <div className="flex flex-col gap-3 px-6 py-5 sm:px-7" data-testid={`${TEST_ID}-ask-owner`}>
        {error ? <Banner intent="warning">{error}</Banner> : null}
        <p className="text-callout text-foreground">
          {formatMessage({ id: "upgradeDialog.askIntro" }, { server: serverName })}
        </p>
        {recipient === null ? null : <OwnerPicker state={ownerState} disabled={sending} testIdPrefix={TEST_ID} />}
        <Field invalid={tooLong}>
          <Textarea
            aria-label={formatMessage({ id: "upgradeDialog.messageLabel" })}
            value={text}
            onChange={handleTextChange}
            rows={4}
            className="resize-none"
            disabled={sending}
            // The card's reason holds one sentence (plan:upgrade).
            maxLength={asCard ? PLAN_UPGRADE_REASON_MAX_LENGTH : undefined}
            data-invalid={tooLong || undefined}
            data-testid={`${TEST_ID}-message`}
          />
          {/* Why Send is off: the text is over the card's limit. */}
          {tooLong ? (
            <FieldError match data-testid={`${TEST_ID}-too-long`}>
              {formatMessage({ id: "upgradeDialog.reasonTooLong" }, { max: PLAN_UPGRADE_REASON_MAX_LENGTH })}
            </FieldError>
          ) : null}
        </Field>
      </div>
    </DialogFrame>
  );
}

/** The frame both halves share: the onboarding step frame, the close ×, the offer, the pricing link. */
function DialogFrame({
  gate,
  serverName,
  billingInterval = "annual",
  prepaidPeriod,
  pricePending = false,
  renewUntil,
  renewInGrace = false,
  action,
  children,
}: {
  gate: UpgradeGate;
  serverName: string;
  billingInterval?: "annual" | "monthly";
  /** Paying once with Alipay: the offer's sticker quotes this period. */
  prepaidPeriod?: PrepaidOfferPeriod | null;
  /** Paying once before the offer's price is known (a renewal loading, or unavailable). */
  pricePending?: boolean;
  /** Renewing prepaid Pro: its current end, for the title and the line under it. */
  renewUntil?: string | null;
  /** That end has passed and the grace days are running. */
  renewInGrace?: boolean;
  action: ReactNode;
  children: ReactNode;
}) {
  const { formatMessage, formatDate } = useIntl();
  const { options: timeOptions } = useTimeFormatter();
  const uploadContext = useUpgradeDialogStore((state) => state.request?.uploadContext);
  const historyContext = useUpgradeDialogStore((state) => (state.request?.gate === "history_30d" ? state.request.historyContext : undefined));
  const externalContext = useUpgradeDialogStore((state) => (state.request?.gate === "external_channel_free_limit" ? state.request.externalContext : undefined));
  const copy = { ...upgradeGateCopy(formatMessage, gate, serverName), ...externalLimitCopy(formatMessage, externalContext, serverName) };
  const agentTries = useServerStore((state) => state.billing?.agentHistoryBlocks7d ?? 0);
  const hint = renewUntil
    ? formatMessage({ id: renewInGrace ? "upgradeDialog.renew.hintGrace" : "upgradeDialog.renew.hint" }, { date: formatDate(renewUntil, { dateStyle: "medium" }) })
    : uploadContext ? uploadLimitHint(formatMessage, formatDate, uploadContext, serverName)
      : historyContext ? historyLimitHint(formatMessage, formatDate, historyContext, timeOptions.timeZone, agentTries) : copy.hint;
  // Some of the month is left, just not enough for the file: "used up" would be wrong.
  const title = renewUntil
    ? formatMessage({ id: "upgradeDialog.renew.title" }, { server: serverName })
    : uploadContext?.kind === "monthly_quota" && uploadContext.quota.remainingBytes >= MONTHLY_UPLOAD_USED_UP_BELOW_BYTES
      ? formatMessage({ id: "upgradeDialog.uploadQuota.titleShort" })
      : copy.title;
  return (
    <SetupStepFrame
      testId={TEST_ID}
      titleId={TITLE_ID}
      headerAction={<DialogClose aria-label={formatMessage({ id: "common.close" })} data-testid={`${TEST_ID}-close`} />}
      eyebrow={renewUntil ? undefined : formatMessage({ id: "upgradeDialog.eyebrow" })}
      title={title}
      hint={hint}
      flushBody
      bodyClassName="md:grid md:h-full md:grid-cols-[0.95fr_1.05fr] md:overflow-hidden"
      footer={
        <>
          {/* TextLink takes the size of the text around it; alone, its container sets it (Raft DS). */}
          <span className="text-footnote">
            <TextLink
              variant="muted"
              render={<a href={PRICING_URL} target="_blank" rel="noopener noreferrer" aria-label={opensInNewTabAriaLabel(formatMessage, formatMessage({ id: "upgradeDialog.pricing" }))} data-testid={`${TEST_ID}-pricing`} />}
            >
              {formatMessage({ id: "upgradeDialog.pricing" })}
              <TextLinkExternalIcon label={formatMessage({ id: "common.opensInNewTab" })} />
            </TextLink>
          </span>
          {action}
        </>
      }
    >
      <ProOfferPanel billingInterval={billingInterval} prepaidPeriod={prepaidPeriod} pricePending={pricePending} first={GATE_HIGHLIGHT[gate]} testIdPrefix={TEST_ID} />
      {children}
    </SetupStepFrame>
  );
}

/** A finite lifetime allowance is managed through AppSumo, without a new Stripe purchase. */
function AppSumoUploadLimit({ quota, canManage, onClose }: { quota: MonthlyUploadQuota | null; canManage: boolean; onClose: () => void }) {
  const { formatMessage, formatNumber, formatDate } = useIntl();
  const navigate = useNavigate();
  const server = useServerStore((state) => state.current);
  const openBilling = useCallback(() => {
    if (!server) return;
    onClose();
    navigate(`/s/${encodeURIComponent(server.slug)}/settings/billing`);
  }, [navigate, onClose, server]);
  const amount = (bytes: number) => formatMessage({ id: bytes >= 1024 ** 3 ? "appsumo.uploadGiB" : "appsumo.uploadMiB" }, {
    count: formatNumber(bytes / (bytes >= 1024 ** 3 ? 1024 ** 3 : 1024 ** 2), { maximumFractionDigits: 2 }),
  });
  return <SetupStepFrame testId={TEST_ID} titleId={TITLE_ID}
    title={formatMessage({ id: "appsumo.uploadLimitTitle" })}
    headerAction={<DialogClose aria-label={formatMessage({ id: "common.close" })} data-testid={`${TEST_ID}-close`} />}
    footer={canManage ? <Button onClick={openBilling}>{formatMessage({ id: "appsumo.managePlan" })}</Button> : <Button onClick={onClose}>{formatMessage({ id: "common.close" })}</Button>}>
    {quota && <p className="text-callout text-foreground">{formatMessage({ id: "appsumo.uploadUsed" }, { used: amount(Math.max(0, quota.limitBytes - quota.remainingBytes)), limit: amount(quota.limitBytes), date: formatDate(monthlyUploadResetsAt(quota), { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" }) })}</p>}
    <p className="mt-3 text-callout text-foreground-muted">{formatMessage({ id: canManage ? "appsumo.uploadManageHelp" : "appsumo.uploadAskOwner" })}</p>
  </SetupStepFrame>;
}

/**
 * The dialog for a server of the viewer's other than the current one, on a
 * page outside the app (the invite and approval pages): ServerUpgradeDialog
 * reads its billing and tells when it is paid. Only an owner opens it there,
 * so it is the owner's half: the choices and checkout, nothing to ask.
 */
export function ServerOwnerUpgradeDialog({
  gate,
  stage,
  serverId,
  serverName,
  surface,
  billing,
  onOpenChange,
}: {
  gate: UpgradeGate;
  stage: UpgradeDialogStage;
  serverId: string;
  serverName: string;
  surface?: PaywallSurface;
  billing: BillingInfo | null;
  onOpenChange: (open: boolean) => void;
}) {
  const target = useMemo(() => ({ id: serverId, billing }), [serverId, billing]);
  return (
    <Dialog open onOpenChange={onOpenChange} disablePointerDismissal>
      <FramedDialogContent narrow="sheet" layer={1} aria-labelledby={TITLE_ID} className="w-full max-w-[720px]">
        <OwnerPart gate={gate} stage={stage} serverName={serverName} surface={surface} target={target} />
      </FramedDialogContent>
    </Dialog>
  );
}

/**
 * Mounted on demand by DeferredUpgradeDialogHost (while a paywall asks for it, or
 * Stripe brought the page back). Shows the dialog the store asks for, brings it back when
 * Stripe returns (`?upgrade=<gate>`), and closes it with a toast once the plan is Pro.
 */
export default function UpgradeDialogHost() {
  const { formatMessage, formatDate } = useIntl();
  const location = useLocation();
  const navigate = useNavigate();
  const request = useUpgradeDialogStore((state) => state.request);
  const open = useUpgradeDialogStore((state) => state.open);
  const close = useUpgradeDialogStore((state) => state.close);
  const server = useServerStore((state) => state.current);
  const { capabilities } = useServerPermissions();
  const serverId = server?.id;
  const serverName = server?.name ?? "";
  const billing = useServerStore((state) => state.billing);
  const uploadQuota = request?.uploadContext?.kind === "monthly_quota" ? request.uploadContext.quota : readMonthlyUploadQuota(billing?.fileUploadQuota);
  const managedUpload = request?.gate === "upload_monthly_quota" && (billing?.source === "appsumo" || uploadQuota?.source === "appsumo");
  const free = isFreePlan(server?.plan);
  // A page outside the app shows its own (ServerUpgradeDialog).
  const forThisServer = Boolean(request && !request.onPage && serverId && request.serverId === serverId);
  // On a phone the dialog is a bottom sheet, like the onboarding steps it shares a frame with.
  const handleOpenChange = useCallback((next: boolean) => {
    if (next) return;
    // Closed by the person (Esc, the close button) while still choosing: a
    // paywall's dialog left without acting. Paying, sending and the plan
    // turning Pro close through the store, not here.
    const current = useUpgradeDialogStore.getState().request;
    if (current && current.stage === "choose" && !current.source && isPaywallGate(current.gate)) {
      trackPaywallAction(current.gate, "dismiss", current.surface);
    }
    // Plan & Billing's Upgrade to Pro opened it: the same moment is its dismissal.
    if (current && current.stage === "choose" && current.settingsEntry) {
      trackPlanBillingDialogClosed("upgrade", "dismissed");
    }
    // An agent's upgrade card opened it: leaving it the same way is the card's
    // dismiss (the card has no close of its own; the server checks the card).
    if (current && current.stage === "choose" && current.cardMessageId) {
      emitActionCardEvent(current.cardMessageId, "action_card.dismiss");
    }
    close();
  }, [close]);

  // Back from Stripe: drop the marker through the router (so no later navigation writes
  // it back), then wait for the plan, or offer the choices again after a cancel.
  useEffect(() => {
    if (!serverId) return;
    const params = new URLSearchParams(location.search);
    const gate = params.get(UPGRADE_RETURN_PARAM);
    if (!isUpgradeGate(gate)) return;
    const canceled = params.get(CANCELED_PARAM) === "1";
    const source = readUpgradeSource(params.get(SOURCE_PARAM));
    const settingsEntry = readSettingsEntry(params.get(ENTRY_PARAM));
    const surface = readSurface(params.get(SURFACE_PARAM));
    const renewFromParam = params.get(RENEW_FROM_PARAM);
    const renewFrom = renewFromParam && Number.isFinite(Date.parse(renewFromParam)) ? renewFromParam : undefined;
    params.delete(UPGRADE_RETURN_PARAM);
    params.delete(CANCELED_PARAM);
    params.delete(SOURCE_PARAM);
    params.delete(ENTRY_PARAM);
    params.delete(RENEW_FROM_PARAM);
    params.delete(SURFACE_PARAM);
    const search = params.toString();
    navigate(
      { pathname: location.pathname, search: search ? `?${search}` : "", hash: location.hash },
      { replace: true, state: location.state },
    );
    open(gate, serverId, { stage: canceled ? "choose" : "confirming", source, surface, settingsEntry, renewFrom });
  }, [location.hash, location.pathname, location.search, location.state, navigate, open, serverId]);

  // A dialog opened for another server never shows here.
  useEffect(() => {
    if (request && serverId && request.serverId !== serverId) close();
  }, [close, request, serverId]);

  // Paid: the plan turns Pro (server:plan-updated), the dialog closes and says so.
  // A prepaid renewal is paid when the paid end moves past where it was (the
  // server is Pro already; the same event reloads billing).
  const renewFrom = request?.renewFrom;
  const renewedUntil = renewFrom && billing?.prepaid?.endsAt && Date.parse(billing.prepaid.endsAt) > Date.parse(renewFrom) ? billing.prepaid.endsAt : null;
  const paidGate = request && forThisServer && request.stage !== "choose" && (renewFrom ? Boolean(renewedUntil) : !free) ? request.gate : null;
  useEffect(() => {
    if (!paidGate) return;
    close();
    showToast(renewedUntil ? {
      title: formatMessage({ id: "upgradeDialog.renewedToast" }, { server: serverName }),
      description: formatMessage({ id: "upgradeDialog.renewedToastBody" }, { date: formatDate(renewedUntil, { dateStyle: "medium" }) }),
      type: "success",
      data: { intent: "success" },
    } : {
      title: formatMessage({ id: "upgradeDialog.paidToast" }, { server: serverName }),
      description: formatMessage({ id: GATE_COPY[paidGate].done }, gateValues(serverName)),
      type: "success",
      data: { intent: "success" },
    });
  }, [close, formatDate, formatMessage, paidGate, renewedUntil, serverName]);

  if (!request || !forThisServer || paidGate) return null;
  // raft-ui Dialog: the dialog role and name, the focus trap, Esc, and focus back to the
  // Upgrade that opened it. The onboarding frame inside is the visible card, so on a
  // desktop the popup itself is unframed (FramedDialogContent); a half-written message
  // is not lost to a click outside. Global shortcuts (⌘K) stop while it is open.
  return (
    <Dialog open onOpenChange={handleOpenChange} disablePointerDismissal>
      <FramedDialogContent
        narrow="sheet"
        layer={1}
        aria-labelledby={TITLE_ID}
        className="w-full max-w-[720px]"
      >
        {billing?.appsumoBillingReserved && !billing.appsumo ? (
          <SetupStepFrame testId={TEST_ID} titleId={TITLE_ID}
            title={formatMessage({ id: "billing.appsumoPendingTitle" })}
            headerAction={<DialogClose aria-label={formatMessage({ id: "common.close" })} />}
            footer={<Button onClick={close}>{formatMessage({ id: "common.close" })}</Button>}>
            <p className="text-callout text-foreground-muted">{formatMessage({ id: "billing.appsumoPendingBilling" })}</p>
          </SetupStepFrame>
        ) : managedUpload ? (
          <AppSumoUploadLimit quota={uploadQuota} canManage={capabilities.manageBilling} onClose={close} />
        ) : capabilities.manageBilling ? (
          <OwnerPart gate={request.gate} stage={request.stage} serverName={serverName} source={request.source} surface={request.surface} settingsEntry={request.settingsEntry} />
        ) : (
          <AskOwnerPart gate={request.gate} serverName={serverName} source={request.source} surface={request.surface} settingsEntry={request.settingsEntry} externalContext={request.externalContext} />
        )}
      </FramedDialogContent>
    </Dialog>
  );
}
