import { Card } from "@botiverse/raft-ui";
import { CreditCard } from "lucide-react";
import { useServerStore } from "../../../store/serverStore";
import { useServerPermissions } from "../../../hooks/useServerPermissions";
import { useIntl } from "react-intl";
import SectionHeader from "../../../components/ui/SectionHeader";
import { PlanBillingLoadingSection } from "./PlanBillingLoadingSection";
import { PlanSection } from "./PlanSection";

export function BillingTabContent() {
  const { formatMessage } = useIntl();
  const server = useServerStore((s) => s.current);
  const loadingServers = useServerStore((s) => s.loading);
  const { capabilities } = useServerPermissions();

  if (!server && loadingServers) {
    return <PlanBillingLoadingSection />;
  }

  if (!capabilities.viewBilling) {
    return (
      <div className="mb-6">
        <SectionHeader
          className="mb-3"
          icon={<CreditCard size={16} />}
          label={formatMessage({ id: "billing.billing" })}
        />
        <Card className="p-4 text-callout text-foreground-muted">
          {formatMessage({ id: "billing.onlyServerOwnersAndAdminsCanViewBilling" })}
        </Card>
      </div>
    );
  }
  return (
    <>
      <PlanSection />
    </>
  );
}
