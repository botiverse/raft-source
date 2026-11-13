import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import { Dialog, DialogClose, Separator, Spinner, TextLink, TextLinkExternalIcon } from "@botiverse/raft-ui";
import { PRO_AGENT_SEAT_BLOCK_SIZE, seatTenths, seatsFromTenths } from "@botiverse/raft-shared";
import { FramedDialogContent } from "../ui/NarrowDialog";
import SetupStepFrame from "../onboarding/SetupStepFrame";
import { opensInNewTabAriaLabel } from "../ui/LeavingRaftMark";
import { SETUP_PAPER, SETUP_PAPER_DOT_GRID, SETUP_STICKER_CARD } from "../onboarding/setupPaper";
import BillingWaiting from "./BillingWaiting";
import type { AddSeatsNeed } from "./AddSeatsDialog";

// The add-seats dialog's frame and the pieces its halves share (AddSeatsDialog.tsx):
// the owner's subscription half, the prepaid half (PrepaidSeatsPart.tsx) and the ask.

const TEST_ID = "add-seats-dialog";
const TITLE_ID = "add-seats-dialog-title";
const PRICING_URL = "https://raft.build/pricing";
const CONFIRMING_SLOW_MS = 30_000;

/**
 * The dialog both halves share: the upgrade dialog's 720 frame, the close ×,
 * why the seats ran out on the left, and the pricing link in the footer.
 */
export function SeatsFrame({
  need,
  seats,
  humans,
  agents,
  right,
  action,
  onOpenChange,
  closeDisabled,
}: {
  need: AddSeatsNeed;
  seats: number;
  humans: number;
  agents: number;
  right: ReactNode;
  action: ReactNode;
  onOpenChange: (open: boolean) => void;
  closeDisabled: boolean;
}) {
  const { formatMessage } = useIntl();
  return (
    <Dialog open onOpenChange={onOpenChange} disablePointerDismissal>
      <FramedDialogContent
        narrow="sheet"
        layer={1}
        aria-labelledby={TITLE_ID}
        className="w-full max-w-[720px]"
      >
        <SetupStepFrame
          testId={TEST_ID}
          titleId={TITLE_ID}
          headerAction={<DialogClose disabled={closeDisabled} aria-label={formatMessage({ id: "common.close" })} data-testid={`${TEST_ID}-close`} />}
          eyebrow={formatMessage({ id: "addSeats.eyebrow" })}
          title={need.title}
          hint={need.hint}
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
          <SeatSum humans={humans} agents={agents} seats={seats} need={need} />
          {right}
        </SetupStepFrame>
      </FramedDialogContent>
    </Dialog>
  );
}

/**
 * Why the seats ran out, as a sum on the onboarding's dotted paper: bought,
 * each kind (count × share), used, then what this action adds, which takes it
 * past what was bought. It grows by kinds, not by seats, so 4 seats or 400
 * read the same.
 */
export function SeatSum({ humans, agents, seats, need }: { humans: number; agents: number; seats: number; need: AddSeatsNeed }) {
  const { formatMessage, formatNumber } = useIntl();
  const usedTenths = seatTenths(humans, agents);
  const seatsNumber = (tenths: number) => formatNumber(seatsFromTenths(tenths), { maximumFractionDigits: 1 });
  return (
    <div className={`${SETUP_PAPER} flex flex-col justify-center gap-3 border-b border-line-seam px-6 py-5 sm:px-7 md:border-b-0 md:border-r`} data-testid={`${TEST_ID}-sum`}>
      <div className={SETUP_PAPER_DOT_GRID} aria-hidden="true" />
      <p className="relative text-subhead font-bold text-foreground">{formatMessage({ id: need.gate ? "addSeats.why" : "addSeats.settings.sumTitle" })}</p>
      <div className={`${SETUP_STICKER_CARD} px-4 py-3 text-callout`}>
        <SumRow label={formatMessage({ id: "addSeats.bought" })} value={formatMessage({ id: "addSeats.boughtValue" }, { seats })} strong />
        <Separator className="my-2" />
        <SumRow label={formatMessage({ id: "addSeats.humansRow" }, { count: humans })} value={seatsNumber(humans * PRO_AGENT_SEAT_BLOCK_SIZE)} />
        <SumRow label={formatMessage({ id: "addSeats.agentsRow" }, { count: agents })} value={seatsNumber(agents)} />
        <Separator className="my-2" />
        <SumRow label={formatMessage({ id: "addSeats.used" })} value={`${seatsNumber(usedTenths)}/${seats}`} strong />
        {/* Over what was bought: warning-soft, fixable (not pink: the commit is the screen's one pink thing). Plan & Billing adds seats for nothing in particular. */}
        {need.tenths > 0 ? (
          <div className="-mx-2 mt-2 flex items-baseline justify-between gap-3 rounded-control bg-warning-soft px-2 py-1 text-warning-strong" data-testid={`${TEST_ID}-overflow`}>
            <span className="font-bold">{formatMessage({ id: "addSeats.overflowLabel" }, { label: need.label })}</span>
            <span className="font-bold tabular-nums">{formatMessage({ id: "addSeats.overflow" }, { next: seatsNumber(usedTenths + need.tenths), seats })}</span>
          </div>
        ) : null}
      </div>
      <p className="relative text-footnote text-foreground-hint">{formatMessage({ id: "addSeats.sumNote" })}</p>
    </div>
  );
}

function SumRow({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-0.5">
      <span className={strong ? "font-bold text-foreground" : "text-foreground-muted"}>{label}</span>
      <span className={`tabular-nums ${strong ? "font-bold text-foreground" : "text-foreground"}`}>{value}</span>
    </div>
  );
}

/** What fits once the seats are added: none to spare, agents, or people and agents. */
export function RoomLine({ total, roomTenths }: { total: number; roomTenths: number }) {
  const { formatMessage } = useIntl();
  const people = Math.floor(roomTenths / PRO_AGENT_SEAT_BLOCK_SIZE);
  const agents = roomTenths % PRO_AGENT_SEAT_BLOCK_SIZE;
  if (roomTenths <= 0) return <>{formatMessage({ id: "addSeats.roomExact" }, { total })}</>;
  if (people === 0) return <>{formatMessage({ id: "addSeats.roomAgents" }, { total, agents })}</>;
  if (agents === 0) return <>{formatMessage({ id: "addSeats.roomPeople" }, { total, people })}</>;
  return <>{formatMessage({ id: "addSeats.roomPeopleAndAgents" }, { total, people, agents })}</>;
}

export function PriceRow({ label, note, value, strong }: { label: string; note: string | null; value: string | null; strong?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <p className="text-callout font-bold text-foreground">{label}</p>
        {note ? <p className="text-footnote text-foreground-muted">{note}</p> : null}
      </div>
      {value
        ? <p className={`shrink-0 tabular-nums text-foreground ${strong ? "text-title" : "text-subhead font-bold"}`}>{value}</p>
        : <Spinner size="sm" aria-hidden="true" />}
    </div>
  );
}

export function PayingView({ resume }: { resume: string }) {
  const { formatMessage } = useIntl();
  const [slow, setSlow] = useState(false);
  // A webhook can take a while; after half a minute say so, as the upgrade dialog does.
  useEffect(() => {
    const timer = window.setTimeout(() => setSlow(true), CONFIRMING_SLOW_MS);
    return () => window.clearTimeout(timer);
  }, []);
  return (
    <BillingWaiting
      testId={`${TEST_ID}-waiting`}
      title={formatMessage({ id: "addSeats.payingTitle" })}
      body={slow ? formatMessage({ id: "addSeats.payingSlow" }) : formatMessage({ id: "addSeats.payingBody" }, { resume })}
    />
  );
}
