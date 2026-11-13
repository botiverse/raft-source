import { useCallback, useState } from "react";
import { useIntl } from "react-intl";
import { Minus, Plus } from "lucide-react";
import { Button } from "@botiverse/raft-ui";
import { calculateProPrice } from "@botiverse/raft-shared";
import type { BillingEntry } from "@botiverse/raft-shared";
import api from "../../api/client";
import ConfirmDialog from "../ConfirmDialog";

const TEST_ID = "manage-seats-dialog";

/**
 * Plan & Billing's Manage Seats (tasks #13 and #18, #proj-commercial): the seat
 * total after this, down to what the server uses. Stripe lowers the
 * subscription at once and credits the unused time on the next invoice; the
 * server refuses a total below what is in use, so a race with a new member
 * fails here, not later.
 */
export function ManageSeatsDialog({
  serverName,
  seats,
  used,
  minimum,
  priced,
  annual,
  entry,
  onClose,
  onRemoved,
}: {
  serverName: string;
  /** Seats bought now. */
  seats: number;
  /** Seats its people and agents use (an agent is a tenth). */
  used: number;
  /** The fewest the server can keep: `used`, rounded up. */
  minimum: number;
  /** Whether the page shows a price for the plan; without one, neither does this. */
  priced: boolean;
  annual: boolean;
  /** The seat update's billing entry: the paywall that opened the page, or `settings`. */
  entry: BillingEntry;
  onClose: () => void;
  /** Removed: the count taken off, for the page's notice. */
  onRemoved: (count: number) => void | Promise<void>;
}) {
  const { formatMessage, formatNumber } = useIntl();
  const [total, setTotal] = useState(() => Math.max(minimum, seats - 1));
  const fewer = useCallback(() => setTotal((value) => Math.max(minimum, value - 1)), [minimum]);
  const more = useCallback(() => setTotal((value) => Math.min(seats - 1, value + 1)), [seats]);
  const count = seats - total;
  // The list price of the new total, as the plan card will show it after (Stripe applies any discount).
  const listed = calculateProPrice(total, annual ? "annual" : "monthly");
  const price = priced ? Math.round((annual ? listed.annualUsd ?? 0 : listed.monthlyUsd) * 100) / 100 : null;
  const remove = useCallback(async () => {
    await api.post("/billing/seat-pack-quantity", { seatQuantity: total, entry });
    await onRemoved(count);
  }, [count, entry, onRemoved, total]);

  return (
    <ConfirmDialog
      title={formatMessage({ id: "planBilling.manageSeats.title" })}
      message={(
        <div className="grid gap-4" data-testid={TEST_ID}>
          <p className="text-callout text-foreground-muted">
            {formatMessage(
              { id: "planBilling.manageSeats.body" },
              { server: serverName, seats, used: formatNumber(used, { maximumFractionDigits: 1 }), minimum },
            )}
          </p>
          <div className="flex items-center gap-4">
            <div className="min-w-0 flex-1">
              <p id={`${TEST_ID}-label`} className="text-subhead font-bold text-foreground">{formatMessage({ id: "planBilling.manageSeats.after" })}</p>
              {price != null && (
                <p id={`${TEST_ID}-price`} className="text-footnote text-foreground-muted" data-testid={`${TEST_ID}-price`}>
                  {formatMessage(
                    { id: annual ? "planBilling.pro.priceYearly" : "planBilling.pro.priceMonthly" },
                    { amount: formatNumber(price, { style: "currency", currency: "USD", minimumFractionDigits: Number.isInteger(price) ? 0 : 2 }) },
                  )}
                </p>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="icon-md"
                onClick={fewer}
                disabled={total <= minimum}
                aria-label={formatMessage({ id: "planBilling.manageSeats.fewer" })}
                data-testid={`${TEST_ID}-fewer`}
              >
                <Minus size={16} aria-hidden="true" />
              </Button>
              <output aria-labelledby={`${TEST_ID}-label`} aria-describedby={price != null ? `${TEST_ID}-price` : undefined} className="w-8 text-center text-subhead font-bold tabular-nums text-foreground" aria-live="polite" data-testid={`${TEST_ID}-total`}>
                {total}
              </output>
              <Button
                type="button"
                variant="outline"
                size="icon-md"
                onClick={more}
                disabled={total >= seats - 1}
                aria-label={formatMessage({ id: "planBilling.manageSeats.more" })}
                data-testid={`${TEST_ID}-more`}
              >
                <Plus size={16} aria-hidden="true" />
              </Button>
            </div>
          </div>
          <p className="text-footnote text-foreground-hint">{formatMessage({ id: "planBilling.removeSeats.credit" })}</p>
        </div>
      )}
      plainMessage
      maxWidthClass="max-w-md"
      confirmLabel={formatMessage({ id: "planBilling.removeSeats.commit" }, { count })}
      loadingLabel={formatMessage({ id: "planBilling.removeSeats.removing" })}
      confirmVariant="warning"
      confirmDisabled={count < 1}
      confirmTestId={`${TEST_ID}-commit`}
      onConfirm={remove}
      onClose={onClose}
    />
  );
}
