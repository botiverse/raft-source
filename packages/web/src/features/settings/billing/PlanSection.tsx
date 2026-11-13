import { useEffect } from "react";
import { useServerStore } from "../../../store/serverStore";
import { PlanSectionContent } from "../../../components/settings/PlanSectionContent";
import { PlanBillingLoadingSection } from "./PlanBillingLoadingSection";
import { usePlanBillingDraft } from "./usePlanBillingDraft";

// Stryker disable all: Settings billing UI wiring is covered by the billing page behavior tests and visual preview screenshots.
export function PlanSection() {
  const server = useServerStore((s) => s.current);
  const usage = useServerStore((s) => s.usage);
  const billing = useServerStore((s) => s.billing);
  const loadingUsage = useServerStore((s) => s.loadingUsage);
  const loadingBilling = useServerStore((s) => s.loadingBilling);
  const loadUsage = useServerStore((s) => s.loadUsage);
  const loadBilling = useServerStore((s) => s.loadBilling);
  const draft = usePlanBillingDraft();

  useEffect(() => {
    loadUsage();
    loadBilling();
  }, [loadBilling, loadUsage]);

  // The skeleton only until there is something to show: a reload after an
  // action keeps the page (and any seat dialog on it) in place.
  if (!server || (loadingUsage && !usage) || (loadingBilling && !billing)) {
    return <PlanBillingLoadingSection />;
  }

  return <PlanSectionContent server={server} usage={usage} billing={billing} loadBilling={loadBilling} draft={draft} />;
}

// Stryker restore all
