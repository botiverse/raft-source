// Plan & billing's layout, shared by the loaded page (PlanSectionContent) and
// its skeleton (PlanBillingLoadingSection), so the cards the skeleton draws are
// the loaded ones' size.

/** The page: its cards in one column, 16px apart. */
export const BILLING_OVERVIEW_CLASS = "mb-6 grid gap-4";
/** The plan card's title: the plan's name. */
export const BILLING_PLAN_TITLE_CLASS = "text-headline";
/** The plan card's summary: its price, seats and renewal, or its limits. */
export const BILLING_PLAN_SUMMARY_CLASS = "m-0 text-callout text-foreground";
/** The usage card's body: its meters and facts. */
export const BILLING_USAGE_CONTENT_CLASS = "grid gap-5";
/** One meter with its facts under it. */
export const BILLING_USAGE_METER_CLASS = "grid gap-2";
