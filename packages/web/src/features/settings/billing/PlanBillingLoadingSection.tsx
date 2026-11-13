import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  DescriptionDetails,
  DescriptionItem,
  DescriptionList,
  DescriptionTerm,
} from "@botiverse/raft-ui";
import { Meter, MeterHeader, MeterLabel, MeterTrack } from "@botiverse/raft-ui/wip";
import { SkeletonTextBar } from "../../../components/ui/Skeleton";
import {
  BILLING_OVERVIEW_CLASS,
  BILLING_PLAN_SUMMARY_CLASS,
  BILLING_PLAN_TITLE_CLASS,
  BILLING_USAGE_CONTENT_CLASS,
  BILLING_USAGE_METER_CLASS,
} from "../../../components/settings/planBillingLayout";

/**
 * Plan & billing while it loads: the two cards every plan shows, at the top of
 * the loaded page (PlanSectionContent's own grid), built from their parts:
 * the plan card (its headline title and one line of its summary) and the
 * usage card (its title, one meter and one line of facts under it, as the
 * seats meter of a Pro server or the uploads meter of a Free one). What only
 * some plans show (the upgrade, billing and cancel cards, a plan's buttons)
 * comes in below them, so nothing above it moves (#proj-raft-ui:#231).
 */
export function PlanBillingLoadingSection() {
  return (
    <div className={BILLING_OVERVIEW_CLASS} aria-busy="true" data-testid="billing-overview-loading">
      <Card aria-hidden="true" data-skeleton="">
        <CardHeader>
          <CardTitle className={BILLING_PLAN_TITLE_CLASS} render={<div />}><SkeletonTextBar className="w-16" /></CardTitle>
        </CardHeader>
        <CardContent>
          {/* Below md the summary wraps: two lines. */}
          <div className={BILLING_PLAN_SUMMARY_CLASS}>
            <div><SkeletonTextBar className="w-80 max-w-full" /></div>
            <div className="md:hidden"><SkeletonTextBar className="w-40" /></div>
          </div>
        </CardContent>
      </Card>

      <Card aria-hidden="true" data-skeleton="">
        <CardHeader>
          <CardTitle render={<div />}><SkeletonTextBar className="w-14" /></CardTitle>
        </CardHeader>
        <CardContent className={BILLING_USAGE_CONTENT_CLASS}>
          <div className={BILLING_USAGE_METER_CLASS}>
            <Meter used={0} valueText="">
              <MeterHeader>
                <MeterLabel><SkeletonTextBar className="w-12" /></MeterLabel>
              </MeterHeader>
              <MeterTrack />
            </Meter>
            <DescriptionList direction="inline">
              <DescriptionItem>
                <DescriptionTerm><SkeletonTextBar className="w-12" /></DescriptionTerm>
                <DescriptionDetails><SkeletonTextBar className="w-16" /></DescriptionDetails>
              </DescriptionItem>
            </DescriptionList>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
