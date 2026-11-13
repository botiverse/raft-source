import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  CardTrailing,
  DescriptionDetails,
  DescriptionItem,
  DescriptionList,
  DescriptionTerm,
  Spinner,
  TextLink,
} from "@botiverse/raft-ui";
import { Meter, MeterHeader, MeterIndicator, MeterLabel, MeterTrack, MeterValue } from "@botiverse/raft-ui/wip";
import { Check } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import type { IntlShape } from "react-intl";
import { FREE_MONTHLY_FILE_UPLOAD_LIMIT_BYTES, PLAN_CONFIG, PRO_AGENT_SEAT_FRACTION, PRO_SEAT_ANNUAL_USD, PRO_SEAT_MONTHLY_USD, formatProAgentSeatFraction } from "@botiverse/raft-shared";
import type { BillingPortalFrom } from "@botiverse/raft-shared";
import { trackPlanBillingDialogClosed, trackPlanBillingDialogOpened } from "../../analytics/planBilling";
import type { MessageId } from "../../i18n/messages";
import type { BillingInfo, Server, ServerUsage } from "../../store/serverStore";
import api from "../../api/client";
import ConfirmDialog from "../ConfirmDialog";
import Banner from "../ui/Banner";
import LeavingRaftMark, { opensInNewTabAriaLabel } from "../ui/LeavingRaftMark";
import { shareableWebUrl } from "../../utils/desktopShell";
import { useBillingReturnRefresh } from "../../hooks/useBillingReturnRefresh";
import { getBillingControlsState, getSettingsBillingPlanPresentation } from "../../utils/billingControls";
import { monthlyUploadResetsAt } from "../../utils/monthlyUploadQuota";
import { openUpgradeDialog } from "../../store/upgradeDialogStore";
import { PRO_PREPAID_FEATURE_FLAG_KEY, useServerFeatureFlag } from "../../store/serverFeatureFlags";
import type { AddSeatsNeed } from "../billing/AddSeatsDialog";
import {
  BILLING_OVERVIEW_CLASS,
  BILLING_PLAN_SUMMARY_CLASS,
  BILLING_PLAN_TITLE_CLASS,
  BILLING_USAGE_CONTENT_CLASS,
  BILLING_USAGE_METER_CLASS,
} from "./planBillingLayout";
import { ManageSeatsDialog } from "../billing/ManageSeatsDialog";
import { DowngradeWarningCard } from "../../features/settings/billing/DowngradeWarningCard";
import { HostedRuntimeSpendCard } from "./HostedRuntimeSpendCard";
import { deferredDialog } from "../../boot/deferredUi";
import type { usePlanBillingDraft } from "../../features/settings/billing/usePlanBillingDraft";

// Loaded when it opens, as everywhere else (a deferred module with a chunk of its own).
const AddSeatsDialog = deferredDialog(() => import("../billing/AddSeatsDialog"));
/** Prepaid Pro shows its end on the page this many days ahead. */
const PREPAID_REMINDER_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

const PRICING_URL = "https://raft.build/pricing";
const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
/** What Pro adds over Free: the Pro plan's own list (billingControls), less "everything in Free" and "coming soon". */
const PRO_ADDS: MessageId[] = [
  "billing.unlimitedMessageHistory",
  "billing.higherFileUploadLimits",
  "billing.agentMigration",
  "billing.unlimitedJointChannels",
];

/**
 * Settings › Plan & Billing (task #13, #proj-commercial; option B, cindyz
 * 2026-10-30): an overview, one card per question. The plan and when it
 * renews; what is used; on Free, what Pro adds; on Pro, how it is billed; and
 * cancelling, last. Buying goes through the dialogs every other Upgrade and
 * Add Seats opens, not a form on this page. Problems with the subscription (a
 * failed payment, a cancellation on its way) are banners at the top.
 */
// Stryker disable all: Settings billing UI wiring is covered by the billing page behavior tests and visual preview screenshots.
export function PlanSectionContent({
  server,
  usage,
  billing,
  loadBilling,
  draft,
}: {
  server: Server;
  usage: ServerUsage | null;
  billing: BillingInfo | null;
  loadBilling: () => Promise<void>;
  draft: ReturnType<typeof usePlanBillingDraft>;
}) {
  const { formatMessage, formatDate, formatNumber } = useIntl();
  const {
    billingAction, setBillingAction,
    billingError, setBillingError,
    billingNotice, setBillingNotice,
    showCancelSubscriptionConfirm, setShowCancelSubscriptionConfirm,
    seatDialog, setSeatDialog,
    billingEntry,
  } = draft;

  const plan = billing?.plan ?? server.plan;
  const config = PLAN_CONFIG[plan as keyof typeof PLAN_CONFIG] ?? PLAN_CONFIG.free;
  const appsumo = billing?.appsumo ?? null;
  const controls = getBillingControlsState({
    source: billing?.source,
    appsumoBillingReserved: billing?.appsumoBillingReserved,
    plan,
    subscriptionStatus: billing?.subscription?.status ?? null,
  });
  const isFree = plan === "free" && !appsumo;
  const isPro = plan === "pro" && !appsumo;
  const owner = billing?.permissions?.canManageBilling === true;
  const subscription = controls.hasEntitlingSubscription ? billing?.subscription ?? null : null;
  const pastDue = subscription?.status === "past_due";
  const ending = subscription?.cancelAtPeriodEnd === true;
  const periodEnd = subscription?.currentPeriodEnd ? new Date(subscription.currentPeriodEnd) : null;
  const periodEndLabel = periodEnd && Number.isFinite(periodEnd.getTime())
    ? formatDate(periodEnd, { month: "short", day: "numeric", year: "numeric" })
    : null;
  const annual = (subscription?.billingInterval ?? billing?.price?.billingInterval) === "annual";
  const seats = Math.max(0, billing?.provisioned?.proPackQuantity ?? 0);
  const usedSeats = Math.max(0, billing?.usage?.universalSeats ?? 0);
  // The fewest seats the server can keep: what its people and agents use (the server checks the same).
  const neededSeats = Math.max(1, Math.ceil(usedSeats));
  const humans = billing?.usage?.humans ?? 0;
  const agents = billing?.usage?.agents ?? usage?.agents ?? 0;
  const freeHistoryDays = PLAN_CONFIG.free.limits.messageHistoryDays;
  const freeUpload = formatBytes(FREE_MONTHLY_FILE_UPLOAD_LIMIT_BYTES);
  // Why buttons that change billing are off: not an owner, or no Stripe here.
  const disabledReason = !owner
    ? formatMessage({ id: "billing.onlyServerOwnersCanChangeBilling" })
    : !billing?.stripeConfigured
      ? formatMessage({ id: "billing.paidPlansAreNotAvailableYet" })
      : null;
  const seatEntry = billingEntry;
  // Prepaid Pro (task #19): paid once with Alipay until a date, renewed from here.
  const prepaid = billing?.source === "prepaid" ? billing.prepaid ?? null : null;
  const prepaidEnabled = useServerFeatureFlag(PRO_PREPAID_FEATURE_FLAG_KEY).enabled;
  const prepaidEndLabel = prepaid ? formatDate(prepaid.endsAt, { month: "short", day: "numeric", year: "numeric" }) : null;
  const prepaidGraceLabel = prepaid ? formatDate(prepaid.graceEndsAt, { month: "short", day: "numeric", year: "numeric" }) : null;
  // The last week before the end: a reminder on the page (the email and the bell come later).
  const prepaidEndingSoon = Boolean(prepaid && !prepaid.inGrace && Date.parse(prepaid.endsAt) - Date.now() <= PREPAID_REMINDER_DAYS * DAY_MS);
  const canRenew = owner && Boolean(prepaid) && prepaidEnabled;
  // Seats are added to prepaid time for the days left, until it ends; in grace, with a renewal.
  const canAddPrepaidSeats = canRenew && !prepaid?.inGrace;
  const prepaidBanner = Boolean(prepaid && (prepaid.inGrace || prepaidEndingSoon));
  // Kept on Pro, a server using more seats than it has bought has to buy them (see Keep Pro).
  const keepNeedsSeats = owner && controls.canUpdatePacks && ending && !pastDue && neededSeats > seats;

  function formatBytes(bytes: number) {
    if (bytes >= GIB) return formatMessage({ id: "common.fileSize.gb" }, { value: formatNumber(bytes / GIB, { maximumFractionDigits: 1 }) });
    return formatMessage({ id: "common.fileSize.mb" }, { value: formatNumber(bytes / MIB, { maximumFractionDigits: 0 }) });
  }
  function usd(amount: number) {
    return formatNumber(amount, { style: "currency", currency: "USD", minimumFractionDigits: Number.isInteger(amount) ? 0 : 2 });
  }

  // Stripe leaves the window (Raft Desktop): refetch billing on every return.
  const noteStripeOpened = useBillingReturnRefresh();
  // `from`: the button, for the server's billing_portal_opened.
  const openPortal = useCallback(async (from: BillingPortalFrom) => {
    if (disabledReason) return;
    setBillingError("");
    setBillingNotice("");
    setBillingAction("portal");
    try {
      const { data } = await api.post("/billing/portal", { returnUrl: shareableWebUrl(), entry: seatEntry, from });
      noteStripeOpened();
      // A browser leaves for Stripe in this tab; Raft Desktop's shell opens it
      // in the system browser and this page stays, ready again.
      window.location.href = data.url;
      setBillingAction(null);
    } catch (err: any) {
      setBillingError(err.response?.data?.error || formatMessage({ id: "billing.failedToOpenBillingPortal" }));
      setBillingAction(null);
    }
  }, [disabledReason, formatMessage, noteStripeOpened, seatEntry, setBillingAction, setBillingError, setBillingNotice]);
  const handlePortalFromPlanCard = useCallback(() => void openPortal("plan_card"), [openPortal]);
  const handlePortalFromPastDue = useCallback(() => void openPortal("past_due_banner"), [openPortal]);
  // Which add-seats dialog is open, for plan_billing_dialog_*: Keep Pro's (the
  // server has outgrown its seats) or the page's Add Seats.
  const addSeatsDialog = useRef<"add_seats" | "keep_pro">("add_seats");

  // Keep Pro: the same seats again while a cancellation is scheduled reactivates
  // the subscription (POST /billing/seat-pack-quantity, `reactivated`). The
  // server won't keep fewer seats than are in use, so a server that has grown
  // past them adds seats instead, which reactivates it too.
  const handleKeepPro = useCallback(async () => {
    if (disabledReason) return;
    if (keepNeedsSeats) {
      addSeatsDialog.current = "keep_pro";
      trackPlanBillingDialogOpened("keep_pro", seatEntry);
      setSeatDialog("add");
      return;
    }
    setBillingError("");
    setBillingNotice("");
    setBillingAction("keep");
    try {
      await api.post("/billing/seat-pack-quantity", { seatQuantity: seats, entry: seatEntry });
      await loadBilling();
      setBillingNotice(formatMessage({ id: "billing.subscriptionReactivatedYourCurrentProSeatCap" }));
    } catch (err: any) {
      setBillingError(err.response?.data?.error || formatMessage({ id: "billing.failedToUpdateSeats" }));
    } finally {
      setBillingAction(null);
    }
  }, [disabledReason, formatMessage, keepNeedsSeats, loadBilling, seatEntry, seats, setBillingAction, setBillingError, setBillingNotice, setSeatDialog]);

  const handleCancelSubscription = useCallback(async () => {
    if (disabledReason) return;
    setBillingError("");
    setBillingNotice("");
    setBillingAction("cancel");
    try {
      await api.post("/billing/cancel", { entry: seatEntry });
      trackPlanBillingDialogClosed("cancel_subscription", "completed");
      await loadBilling();
      setBillingNotice(formatMessage({ id: "billing.subscriptionCancellationScheduledForTheEndOf" }));
      setShowCancelSubscriptionConfirm(false);
    } catch (err: any) {
      setBillingError(err.response?.data?.error || formatMessage({ id: "billing.failedToCancelSubscription" }));
    } finally {
      setBillingAction(null);
    }
  }, [disabledReason, formatMessage, loadBilling, seatEntry, setBillingAction, setBillingError, setBillingNotice, setShowCancelSubscriptionConfirm]);

  const handleRenew = useCallback(() => {
    if (!prepaid) return;
    trackPlanBillingDialogOpened("upgrade", seatEntry);
    // The dialog sees a prepaid server and renews it (see its OwnerPart).
    openUpgradeDialog("general", { serverId: server.id, unprompted: true, settingsEntry: seatEntry });
  }, [prepaid, seatEntry, server.id]);
  const handleUpgrade = useCallback(() => {
    // The dialog shows an owner the checkout and anyone else a message to an owner.
    trackPlanBillingDialogOpened("upgrade", seatEntry);
    openUpgradeDialog("general", { serverId: server.id, unprompted: true, settingsEntry: seatEntry });
  }, [seatEntry, server.id]);
  const openAddSeats = useCallback(() => {
    setBillingError("");
    setBillingNotice("");
    addSeatsDialog.current = "add_seats";
    trackPlanBillingDialogOpened("add_seats", seatEntry);
    setSeatDialog("add");
  }, [seatEntry, setBillingError, setBillingNotice, setSeatDialog]);
  const openRemoveSeats = useCallback(() => {
    setBillingError("");
    setBillingNotice("");
    trackPlanBillingDialogOpened("remove_seats", seatEntry);
    setSeatDialog("remove");
  }, [seatEntry, setBillingError, setBillingNotice, setSeatDialog]);
  const closeSeatDialog = useCallback(() => {
    trackPlanBillingDialogClosed(seatDialog === "remove" ? "remove_seats" : addSeatsDialog.current, "dismissed");
    setSeatDialog(null);
  }, [seatDialog, setSeatDialog]);
  // Stripe charged for the seats (they count once its webhook lands): done,
  // even if the dialog is closed before then. A payment Stripe held is not.
  const handleSeatsPaid = useCallback(() => trackPlanBillingDialogClosed(addSeatsDialog.current, "completed"), []);
  const handleSeatsAdded = useCallback(() => {
    trackPlanBillingDialogClosed(addSeatsDialog.current, "completed");
    setSeatDialog(null);
  }, [setSeatDialog]);
  // Adding seats for nothing in particular: no paywall, no action waiting on them.
  const addSeatsNeed = useMemo<AddSeatsNeed>(() => ({
    tenths: 0,
    label: "",
    title: formatMessage({ id: "addSeats.settings.title" }, { server: server.name }),
    hint: formatMessage({ id: "addSeats.settings.hint" }, { server: server.name }),
    resume: formatMessage({ id: "addSeats.settings.resume" }),
    entry: seatEntry,
  }), [formatMessage, seatEntry, server.name]);
  const handleSeatsRemoved = useCallback(async (count: number) => {
    trackPlanBillingDialogClosed("remove_seats", "completed");
    await loadBilling();
    setBillingNotice(formatMessage({ id: "planBilling.removeSeats.done" }, { count }));
  }, [formatMessage, loadBilling, setBillingNotice]);
  const openCancelConfirm = useCallback(() => {
    trackPlanBillingDialogOpened("cancel_subscription", seatEntry);
    setShowCancelSubscriptionConfirm(true);
  }, [seatEntry, setShowCancelSubscriptionConfirm]);
  // After a failed cancellation too: the error shows on the page.
  const closeCancelConfirm = useCallback(() => {
    trackPlanBillingDialogClosed("cancel_subscription", "dismissed");
    setShowCancelSubscriptionConfirm(false);
  }, [setShowCancelSubscriptionConfirm]);
  const retryLoad = useCallback(() => void loadBilling(), [loadBilling]);

  // ── The plan card ──
  const presentation = getSettingsBillingPlanPresentation(
    plan,
    config.displayName,
    billing?.provisioned?.humans ?? 0,
    billing?.provisioned?.agents ?? 0,
    seats,
    formatProAgentSeatFraction(),
  );
  const planName = appsumo
    ? formatMessage({ id: "billing.appsumoLifetimePlan" }, { tier: appsumo.tier })
    : formatMessage({ id: presentation.displayName });
  const price = billing?.price
    ? annual && billing.price.annualUsd != null
      ? formatMessage({ id: "planBilling.pro.priceYearly" }, { amount: usd(billing.price.annualUsd) })
      : formatMessage({ id: "planBilling.pro.priceMonthly" }, { amount: usd(billing.price.monthlyUsd) })
    : null;
  let planDescription: string;
  if (appsumo) {
    planDescription = formatMessage({ id: "billing.appsumoManaged" });
  } else if (prepaid && prepaidEndLabel) {
    planDescription = formatMessage({ id: "planBilling.prepaid.summary" }, { seats: prepaid.seatQuantity, date: prepaidEndLabel });
  } else if (isPro && subscription && price && periodEndLabel) {
    planDescription = formatMessage(
      { id: "planBilling.pro.summary" },
      { price, seats, renewal: formatMessage({ id: ending ? "planBilling.endsOn" : "planBilling.pro.renews" }, { date: periodEndLabel }) },
    );
  } else if (isFree) {
    planDescription = formatMessage({ id: "planBilling.free.summary" }, { days: freeHistoryDays, upload: freeUpload });
  } else {
    planDescription = formatMessage({ id: presentation.description }, presentation.descriptionValues);
  }
  // A badge only says what needs a look: a failed payment, an end date, a lifetime license.
  let status: ReactNode = null;
  if (appsumo) status = <Badge appearance="soft" variant="success">{formatMessage({ id: "planBilling.status.lifetime" })}</Badge>;
  else if (prepaid?.inGrace && prepaidEndLabel) status = <Badge appearance="soft" variant="warning">{formatMessage({ id: "planBilling.prepaid.ended" }, { date: prepaidEndLabel })}</Badge>;
  else if (prepaidEndingSoon && prepaidEndLabel) status = <Badge appearance="soft" variant="muted">{formatMessage({ id: "planBilling.endsOn" }, { date: prepaidEndLabel })}</Badge>;
  else if (pastDue) status = <Badge appearance="soft" variant="warning">{formatMessage({ id: "planBilling.paymentFailed" })}</Badge>;
  else if (ending && periodEndLabel) status = <Badge appearance="soft" variant="muted">{formatMessage({ id: "planBilling.endsOn" }, { date: periodEndLabel })}</Badge>;
  // Seats are added from here only on a subscription that is paid up and renewing:
  // adding to one being cancelled would quietly take the cancellation back.
  const canAddSeats = owner && controls.canUpdatePacks && !pastDue && !ending;
  // At least one whole seat unused (task #18): Manage Seats, under the seat count.
  const canRemoveSeats = canAddSeats && seats > neededSeats;
  const showPortal = owner && controls.canOpenPortal;

  // ── Usage ──
  const uploadQuota = billing?.fileUploadQuota?.limited && billing.fileUploadQuota.limitBytes > 0 ? billing.fileUploadQuota : null;
  // What is used is what isn't left (reservations for uploads under way count), as the upload limit counts it.
  const uploadUsed = uploadQuota ? Math.min(uploadQuota.limitBytes, Math.max(0, uploadQuota.limitBytes - Math.max(0, uploadQuota.remainingBytes ?? 0))) : 0;
  // When the month starts over; left out when billing doesn't say which month it is.
  const uploadResets = uploadQuota && /^\d{4}-\d{2}$/.test(uploadQuota.month ?? "")
    ? formatDate(monthlyUploadResetsAt(uploadQuota), { month: "short", day: "numeric", timeZone: "UTC" })
    : null;
  const universalSeats = isPro && (billing?.capacity?.maxUniversalSeats ?? -1) !== -1;
  const seatCapacity = Math.max(0, billing?.capacity?.maxUniversalSeats ?? 0);
  const formatSeats = (value: number) => formatNumber(value, { maximumFractionDigits: 1 });

  return (
    <div className={BILLING_OVERVIEW_CLASS} data-testid="billing-overview">
      {billingNotice && (
        <Banner intent="info" density="sm" role="status">{billingNotice}</Banner>
      )}
      {billingError && (
        <Banner intent="warning" density="sm">{billingError}</Banner>
      )}
      {!billing && (
        <Banner
          intent="warning"
          density="sm"
          live={false}
          title={formatMessage({ id: "planBilling.loadFailed.title" })}
          actions={<Button variant="outline" size="md" onClick={retryLoad}>{formatMessage({ id: "planBilling.retry" })}</Button>}
        >
          {formatMessage({ id: "planBilling.loadFailed.body" })}
        </Banner>
      )}
      <DowngradeWarningCard server={server} canManageBilling={owner} />
      {billing?.appsumoBillingReserved && !appsumo && (
        <Banner intent="info" role="status">{formatMessage({ id: "billing.appsumoPendingBilling" })}</Banner>
      )}
      {billing?.sourceConflict === "appsumo_stripe" && billing.subscription && (
        <Banner intent="warning" role="alert">
          <p>{formatMessage({ id: "billing.appsumoStripeConflict" }, { status: billing.subscription.status })}</p>
          {billing.subscription.cancelAtPeriodEnd && <p>{formatMessage({ id: "billing.subscriptionCancellationScheduledForTheEndOf" })}</p>}
          {billing.subscription.currentPeriodEnd && Number.isFinite(Date.parse(billing.subscription.currentPeriodEnd)) && (
            <p>{formatMessage({ id: "billing.appsumoStripePeriodEnd" }, { date: new Date(billing.subscription.currentPeriodEnd) })}</p>
          )}
        </Banner>
      )}
      {isPro && pastDue && (
        <Banner
          intent="warning"
          withIcon
          live={false}
          title={formatMessage({ id: "planBilling.paymentFailed" })}
          actions={showPortal ? (
            <Button variant="outline" size="md" onClick={handlePortalFromPastDue} disabled={!!disabledReason || billingAction != null}>
              {formatMessage({ id: "planBilling.pastDue.action" })}
              <LeavingRaftMark data-icon="inline-end" destination="stripe" />
            </Button>
          ) : undefined}
          data-testid="billing-past-due"
        >
          {formatMessage({ id: owner ? "planBilling.pastDue.body" : "planBilling.pastDue.bodyOther" })}
        </Banner>
      )}
      {isPro && ending && !pastDue && periodEndLabel && (
        <Banner
          intent="info"
          withIcon
          live={false}
          title={formatMessage({ id: "planBilling.ending.title" }, { date: periodEndLabel })}
          actions={owner ? (
            <Button
              variant="accent"
              size="md"
              onClick={handleKeepPro}
              disabled={!!disabledReason || billingAction != null}
              loading={billingAction === "keep"}
              loadingLabel={formatMessage({ id: "planBilling.keepingPro" })}
            >
              {formatMessage({ id: "planBilling.keepPro" })}
            </Button>
          ) : undefined}
          data-testid="billing-ending"
        >
          {formatMessage({ id: "planBilling.ending.body" }, { days: freeHistoryDays, upload: freeUpload })}
        </Banner>
      )}

      {prepaid && prepaidBanner && prepaidEndLabel && prepaidGraceLabel && (
        <Banner
          intent={prepaid.inGrace ? "warning" : "info"}
          withIcon
          live={false}
          title={formatMessage({ id: prepaid.inGrace ? "planBilling.prepaid.graceTitle" : "planBilling.prepaid.endingTitle" }, { date: prepaidEndLabel })}
          actions={canRenew ? (
            <Button variant="accent" size="md" onClick={handleRenew} disabled={!!disabledReason || billingAction != null} data-testid="billing-prepaid-banner-renew">
              {formatMessage({ id: "planBilling.prepaid.renew" })}
            </Button>
          ) : undefined}
          data-testid={prepaid.inGrace ? "billing-prepaid-grace" : "billing-prepaid-ending"}
        >
          {/* "Renew" only where renewing is open: the owner's button, or an owner to ask. */}
          {prepaid.inGrace
            ? formatMessage({ id: !prepaidEnabled ? "planBilling.prepaid.graceBodyNoRenew" : owner ? "planBilling.prepaid.graceBody" : "planBilling.prepaid.graceBodyOther" }, { date: prepaidGraceLabel })
            : formatMessage({ id: !prepaidEnabled ? "planBilling.prepaid.endingBodyNoRenew" : owner ? "planBilling.prepaid.endingBody" : "planBilling.prepaid.endingBodyOther" })}
        </Banner>
      )}

      {/* The plan */}
      <Card id="plan" data-testid="billing-current-plan-card">
        <CardHeader>
          <CardTitle className={BILLING_PLAN_TITLE_CLASS} render={<h2>{planName}</h2>} />
          {status && <CardTrailing>{status}</CardTrailing>}
          {/* AppSumo's line says how to get changes made (recovery); the others are the plan's facts. */}
          {appsumo ? <CardDescription>{planDescription}</CardDescription> : null}
        </CardHeader>
        {/* The plan's price, seats and renewal (or the Free plan's limits) are data: body ink, not CardDescription. */}
        {appsumo ? null : (
          <CardContent>
            <p className={BILLING_PLAN_SUMMARY_CLASS} data-testid="billing-current-plan-summary">{planDescription}</p>
          </CardContent>
        )}
        {(canAddSeats || canAddPrepaidSeats || showPortal || (canRenew && !prepaidBanner)) && (
          <CardContent className="flex flex-wrap gap-2">
            {/* The banner above carries Renew in the last week and the grace days. */}
            {canRenew && !prepaidBanner && (
              <Button variant="accent" size="md" onClick={handleRenew} disabled={!!disabledReason || billingAction != null} data-testid="billing-prepaid-renew">
                {formatMessage({ id: "planBilling.prepaid.renew" })}
              </Button>
            )}
            {canAddSeats && (
              <Button variant="accent" size="md" onClick={openAddSeats} disabled={!!disabledReason || billingAction != null}>
                {formatMessage({ id: "planBilling.addSeats" })}
              </Button>
            )}
            {/* Renew is the accent here; adding seats to prepaid time is the second action. */}
            {canAddPrepaidSeats && (
              <Button variant="outline" size="md" onClick={openAddSeats} disabled={!!disabledReason || billingAction != null} data-testid="billing-prepaid-add-seats">
                {formatMessage({ id: "planBilling.addSeats" })}
              </Button>
            )}
            {showPortal && (
              <Button variant="outline" size="md" onClick={handlePortalFromPlanCard} disabled={!!disabledReason || billingAction != null}>
                {billingAction === "portal" ? formatMessage({ id: "billing.opening" }) : formatMessage({ id: "planBilling.manageInStripe" })}
                <LeavingRaftMark data-icon="inline-end" destination="stripe" />
              </Button>
            )}
          </CardContent>
        )}
      </Card>

      {/* What is used */}
      <Card data-testid="billing-usage-card">
        <CardHeader>
          <CardTitle render={<h2>{formatMessage({ id: "planBilling.usage.title" })}</h2>} />
        </CardHeader>
        <CardContent className={BILLING_USAGE_CONTENT_CLASS}>
          {universalSeats && (
            <div className={BILLING_USAGE_METER_CLASS}>
              <Meter used={usedSeats} max={Math.max(seatCapacity, 0.0001)} valueText={formatMessage({ id: "planBilling.usage.used" }, { used: formatSeats(usedSeats), total: formatSeats(seatCapacity) })}>
                <MeterHeader>
                  <MeterLabel>{formatMessage({ id: "billing.seats" })}</MeterLabel>
                  <MeterValue />
                </MeterHeader>
                <MeterTrack>
                  <MeterIndicator />
                </MeterTrack>
              </Meter>
              {/* Under "n of m used", outside the meter: a meter's contents aren't controls (role="meter"). */}
              <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
                <DescriptionList direction="inline">
                  <DescriptionItem>
                    <DescriptionTerm>{formatMessage({ id: "planBilling.usage.people" })}</DescriptionTerm>
                    <DescriptionDetails>{formatMessage({ id: "planBilling.usage.countSeats" }, { count: humans, seats: formatSeats(humans), seatCount: humans })}</DescriptionDetails>
                  </DescriptionItem>
                  <DescriptionItem>
                    <DescriptionTerm>{formatMessage({ id: "billing.agents" })}</DescriptionTerm>
                    <DescriptionDetails>{formatMessage({ id: "planBilling.usage.countSeats" }, { count: agents, seats: formatSeats(agents * PRO_AGENT_SEAT_FRACTION), seatCount: agents * PRO_AGENT_SEAT_FRACTION })}</DescriptionDetails>
                  </DescriptionItem>
                </DescriptionList>
                {canRemoveSeats && (
                  <TextLink className="text-footnote" onClick={openRemoveSeats} data-testid="billing-manage-seats">
                    {formatMessage({ id: "planBilling.manageSeats" })}
                  </TextLink>
                )}
              </div>
            </div>
          )}
          {appsumo && (
            <>
              <UsageMeter label={formatMessage({ id: "planBilling.usage.people" })} used={humans} max={appsumo.maxHumans} />
              <UsageMeter label={formatMessage({ id: "billing.agents" })} used={agents} max={appsumo.maxAgents} />
              <UsageMeter label={formatMessage({ id: "planBilling.usage.jointChannels" })} used={appsumo.hostedJointChannels} max={appsumo.maxHostedJointChannels} />
            </>
          )}
          {(isFree || appsumo) && uploadQuota && (
            <Meter
              used={uploadUsed}
              max={uploadQuota.limitBytes}
              valueText={uploadResets
                ? formatMessage(
                  { id: uploadQuota.remainingBytes <= 0 ? "planBilling.usage.uploadsUsedUp" : "planBilling.usage.uploadsUsed" },
                  { used: formatBytes(uploadUsed), limit: formatBytes(uploadQuota.limitBytes), date: uploadResets },
                )
                : formatMessage({ id: "planBilling.usage.used" }, { used: formatBytes(uploadUsed), total: formatBytes(uploadQuota.limitBytes) })}
              data-testid="billing-upload-meter"
            >
              <MeterHeader>
                <MeterLabel>{formatMessage({ id: "planBilling.usage.uploads" })}</MeterLabel>
                <MeterValue />
              </MeterHeader>
              <MeterTrack>
                <MeterIndicator />
              </MeterTrack>
            </Meter>
          )}
          {/* Free, and any plan without a seat count (founder, partner, or billing that came back partial). */}
          {!universalSeats && !appsumo && (plan === "free" || billing) && (
            <DescriptionList direction="horizontal">
              {plan === "free" && (
                <DescriptionItem>
                  <DescriptionTerm>{formatMessage({ id: "planBilling.usage.history" })}</DescriptionTerm>
                  <DescriptionDetails>{formatMessage({ id: "planBilling.usage.historyValue" }, { days: freeHistoryDays })}</DescriptionDetails>
                </DescriptionItem>
              )}
              {/* Who is on the server comes with billing: without it, no count rather than a wrong one. */}
              {billing && (
                <DescriptionItem>
                  <DescriptionTerm>{formatMessage({ id: "planBilling.usage.members" })}</DescriptionTerm>
                  <DescriptionDetails>{formatMessage({ id: "planBilling.usage.membersValue" }, { people: humans, agents })}</DescriptionDetails>
                </DescriptionItem>
              )}
            </DescriptionList>
          )}
        </CardContent>
      </Card>

      {billing?.permissions?.canReadBillingSummary === true && <HostedRuntimeSpendCard />}

      {/* Free: what Pro adds */}
      {isFree && billing && controls.canCheckout && (
        <Card data-testid="billing-upgrade-card">
          <CardHeader>
            <CardTitle render={<h2>{formatMessage({ id: "billing.upgradeToPro" })}</h2>} />
          </CardHeader>
          <CardContent className="grid gap-4">
            {/* Prices and the seats this server needs: data, in body ink (not CardDescription). */}
            <p className="m-0 text-callout text-foreground" data-testid="billing-upgrade-price">
              {formatMessage(
                { id: "planBilling.upgrade.description" },
                { monthly: usd(PRO_SEAT_MONTHLY_USD), annual: usd(Math.round((PRO_SEAT_ANNUAL_USD / 12) * 100) / 100), seats: neededSeats },
              )}
            </p>
            <ul className="grid gap-x-6 gap-y-2 text-callout text-foreground sm:grid-cols-2">
              {PRO_ADDS.map((id) => (
                <li key={id} className="flex items-start gap-2">
                  <Check size={16} className="mt-0.5 shrink-0 text-success-strong" aria-hidden="true" />
                  {formatMessage({ id })}
                </li>
              ))}
            </ul>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="accent"
                size="md"
                onClick={handleUpgrade}
                disabled={!billing?.stripeConfigured || billingAction != null}
              >
                {formatMessage({ id: owner ? "billing.upgradeToPro" : "planBilling.upgrade.askOwner" })}
              </Button>
              <Button
                render={<a href={PRICING_URL} target="_blank" rel="noopener noreferrer" aria-label={opensInNewTabAriaLabel(formatMessage, formatMessage({ id: "planBilling.comparePlans" }))} />}
                nativeButton={false}
                size="md"
                variant="ghost"
              >
                {formatMessage({ id: "planBilling.comparePlans" })}
                <LeavingRaftMark data-icon="inline-end" />
              </Button>
            </div>
            {billing && !billing.stripeConfigured && (
              <p className="text-caption text-foreground-hint">{formatMessage({ id: "billing.paidPlansAreNotAvailableYet" })}</p>
            )}
          </CardContent>
        </Card>
      )}

      {/* Pro: how it is billed */}
      {isPro && subscription && (
        <Card data-testid="billing-details-card">
          <CardHeader>
            <CardTitle render={<h2>{formatMessage({ id: "billing.billing" })}</h2>} />
          </CardHeader>
          <CardContent>
            <DescriptionList direction="horizontal">
              <DescriptionItem>
                <DescriptionTerm>{formatMessage({ id: "planBilling.billing.billed" })}</DescriptionTerm>
                <DescriptionDetails>{formatMessage({ id: annual ? "billing.yearly" : "billing.monthly" })}</DescriptionDetails>
              </DescriptionItem>
              {periodEndLabel && (
                <DescriptionItem>
                  <DescriptionTerm>{formatMessage({ id: ending ? "planBilling.billing.lastDay" : "planBilling.billing.renews" })}</DescriptionTerm>
                  <DescriptionDetails>{periodEndLabel}</DescriptionDetails>
                </DescriptionItem>
              )}
              {owner && <PaymentMethodItem />}
              <DescriptionItem>
                <DescriptionTerm>{formatMessage({ id: "billing.seats" })}</DescriptionTerm>
                <DescriptionDetails>
                  {formatMessage({ id: "billing.seatCount" }, { count: seats })}
                </DescriptionDetails>
              </DescriptionItem>
            </DescriptionList>
          </CardContent>
          <CardFooter>
            {formatMessage({ id: owner ? "planBilling.billing.ownerNote" : "planBilling.billing.memberNote" })}
          </CardFooter>
        </Card>
      )}

      {/* Cancelling, last */}
      {isPro && subscription && owner && !ending && periodEndLabel && (
        <Card data-testid="billing-cancel-card">
          <CardHeader>
            <CardTitle render={<h2>{formatMessage({ id: "planBilling.cancel.title" })}</h2>} />
            <CardDescription>
              {formatMessage({ id: "planBilling.cancel.body" }, { date: periodEndLabel, days: freeHistoryDays, upload: freeUpload })}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex justify-end">
            <Button variant="warning" size="md" onClick={openCancelConfirm} disabled={!!disabledReason || billingAction != null}>
              {formatMessage({ id: "billing.cancelSubscription" })}
            </Button>
          </CardContent>
        </Card>
      )}

      {/* A prepaid owner's dialog stays open into the grace days: it turns into Renew itself. */}
      {seatDialog === "add" && (canAddSeats || keepNeedsSeats || (owner && Boolean(prepaid))) && (
        <AddSeatsDialog
          need={addSeatsNeed}
          onClose={closeSeatDialog}
          onPaid={handleSeatsPaid}
          onAdded={handleSeatsAdded}
        />
      )}
      {seatDialog === "remove" && canRemoveSeats && (
        <ManageSeatsDialog
          serverName={server.name}
          seats={seats}
          used={usedSeats}
          minimum={neededSeats}
          priced={price != null}
          annual={annual}
          entry={seatEntry}
          onClose={closeSeatDialog}
          onRemoved={handleSeatsRemoved}
        />
      )}
      {showCancelSubscriptionConfirm && (
        <ConfirmDialog
          title={formatMessage({ id: "billing.cancelSubscription" })}
          message={cancelConfirmMessage(formatMessage, server.name, billing?.externalChannelsTotal)}
          confirmLabel={formatMessage({ id: "billing.cancelSubscription" })}
          loadingLabel={formatMessage({ id: "billing.canceling" })}
          cancelLabel={formatMessage({ id: "billing.keepSubscription" })}
          confirmVariant="warning"
          onConfirm={handleCancelSubscription}
          onClose={closeCancelConfirm}
        />
      )}
    </div>
  );
}
// Stryker restore all

/**
 * The cancel confirmation's words, and, for a server in more than one external
 * channel, what Free does to them when Pro ends (Warden's v4 H, cindyz: no
 * grace period, so they freeze until it is back to one).
 */
function cancelConfirmMessage(formatMessage: IntlShape["formatMessage"], serverName: string, externalChannels: number | undefined): ReactNode {
  const base = formatMessage({ id: "billing.cancelTheWholeProSubscriptionAtTheEndOfTheCu" });
  if (!externalChannels || externalChannels < 2) return base;
  return (
    <>
      <p>{base}</p>
      <p className="mt-2" data-testid="cancel-external-channels">
        {formatMessage({ id: "planBilling.cancel.externalChannels" }, { server: serverName, count: externalChannels })}
      </p>
    </>
  );
}

type PaymentMethod =
  | { type: "card"; brand: string; last4: string; expMonth: number; expYear: number }
  | { type: "bank_account"; last4: string | null; bankName: string | null }
  | { type: string };

/**
 * The Billing card's Payment method row (owners; PR 2 of task #13): what Stripe
 * charges, read when the card shows (GET /billing/payment-method, an outside
 * system). Left out when Stripe can't say.
 */
function PaymentMethodItem() {
  const { formatMessage, formatDate } = useIntl();
  const [state, setState] = useState<{ kind: "loading" } | { kind: "ready"; method: PaymentMethod | null } | { kind: "failed" }>({ kind: "loading" });
  useEffect(() => {
    let cancelled = false;
    api.get<{ paymentMethod: PaymentMethod | null }>("/billing/payment-method")
      .then(({ data }) => { if (!cancelled) setState({ kind: "ready", method: data.paymentMethod ?? null }); })
      .catch(() => { if (!cancelled) setState({ kind: "failed" }); });
    return () => { cancelled = true; };
  }, []);
  if (state.kind === "failed") return null;
  let value: ReactNode;
  if (state.kind === "loading") {
    value = <Spinner size="xs" aria-label={formatMessage({ id: "planBilling.paymentMethod.loading" })} />;
  } else if (!state.method) {
    value = formatMessage({ id: "planBilling.paymentMethod.none" });
  } else if (state.method.type === "card" && "last4" in state.method && "brand" in state.method) {
    value = formatMessage(
      { id: "planBilling.paymentMethod.card" },
      {
        brand: state.method.brand,
        last4: state.method.last4,
        expiry: formatDate(new Date(Date.UTC(state.method.expYear, state.method.expMonth - 1, 1)), { month: "2-digit", year: "2-digit", timeZone: "UTC" }),
      },
    );
  } else if (state.method.type === "bank_account" && "last4" in state.method && state.method.last4) {
    value = formatMessage({ id: "planBilling.paymentMethod.bank" }, { last4: state.method.last4 });
  } else {
    value = formatMessage({ id: "planBilling.paymentMethod.other" });
  }
  return (
    <DescriptionItem data-testid="billing-payment-method">
      <DescriptionTerm>{formatMessage({ id: "planBilling.paymentMethod.title" })}</DescriptionTerm>
      <DescriptionDetails>{value}</DescriptionDetails>
    </DescriptionItem>
  );
}

/** One AppSumo allowance: what is used of the license's limit. */
function UsageMeter({ label, used, max }: { label: string; used: number; max: number }) {
  const { formatMessage, formatNumber } = useIntl();
  return (
    <Meter used={used} max={Math.max(max, 0.0001)} valueText={formatMessage({ id: "planBilling.usage.used" }, { used: formatNumber(used), total: formatNumber(max) })}>
      <MeterHeader>
        <MeterLabel>{label}</MeterLabel>
        <MeterValue />
      </MeterHeader>
      <MeterTrack>
        <MeterIndicator />
      </MeterTrack>
    </Meter>
  );
}
