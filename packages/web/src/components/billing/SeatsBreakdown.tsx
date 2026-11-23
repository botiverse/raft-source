import { useIntl } from "react-intl";
import { DescriptionDetails, DescriptionItem, DescriptionList, DescriptionTerm } from "@botiverse/raft-ui";
import { PRO_AGENT_SEAT_BLOCK_SIZE, seatTenths, seatsFromTenths } from "@botiverse/raft-shared";

/**
 * What a server's seats are made of, in two columns: "4 people | 4 seats",
 * "15 agents | 1.5 seats (1 per 10 agents)". The upgrade dialog's seats row and
 * Plan & billing's seat meter both say it this way (cindyz, option 2,
 * #proj-commercial:83cff16f). No agents row when there are none.
 */
export function SeatsBreakdown({ humans, agents, className, testId }: {
  humans: number;
  agents: number;
  className?: string;
  testId?: string;
}) {
  const { formatMessage, formatNumber } = useIntl();
  const formatSeats = (value: number) => formatNumber(value, { maximumFractionDigits: 1 });
  // In tenths, as the rest of seat math: 0.1 × agents drifts in floating point.
  const agentSeats = seatsFromTenths(seatTenths(0, agents));
  return (
    <DescriptionList direction="horizontal" className={className} data-testid={testId}>
      <DescriptionItem>
        <DescriptionTerm>{formatMessage({ id: "planBilling.usage.peopleCount" }, { count: humans })}</DescriptionTerm>
        <DescriptionDetails>{formatMessage({ id: "planBilling.usage.seatsValue" }, { seats: formatSeats(humans), seatCount: humans })}</DescriptionDetails>
      </DescriptionItem>
      {agents > 0 ? (
        <DescriptionItem>
          <DescriptionTerm>{formatMessage({ id: "planBilling.usage.agentsCount" }, { count: agents })}</DescriptionTerm>
          <DescriptionDetails>
            {formatMessage({ id: "planBilling.usage.agentSeatsValue" }, { seats: formatSeats(agentSeats), seatCount: agentSeats, block: PRO_AGENT_SEAT_BLOCK_SIZE })}
          </DescriptionDetails>
        </DescriptionItem>
      ) : null}
    </DescriptionList>
  );
}
