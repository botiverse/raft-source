import { Button } from "@botiverse/raft-ui";
import { CircleArrowUp } from "lucide-react";
import { useIntl } from "react-intl";
import type { RuntimeUpgradeState } from "./runtimeUpgradeOutcomeCopy";

/**
 * Upgrade (docs/contracts/runtime-auth.md, "Upgrade"): runs the runtime's own
 * updater on the Computer. Raft DS Button: `default` (never pink: it is not
 * the screen's main action, and a banner's button never is), `md` for a
 * banner or a card, and busy (`loading`, "Upgrading…") while the Computer
 * runs it, so it cannot be pressed twice.
 */
export function RuntimeUpgradeButton({ state, onUpgrade }: { state: RuntimeUpgradeState; onUpgrade: () => void }) {
  const { formatMessage } = useIntl();
  const running = state.kind === "running";
  return (
    <Button
      type="button"
      size="md"
      variant="default"
      onClick={onUpgrade}
      loading={running}
      loadingLabel={formatMessage({ id: "machine.runtimeUpgrade.running" })}
      data-testid="runtime-upgrade-action"
    >
      {running ? null : <CircleArrowUp size={16} aria-hidden="true" data-icon="inline-start" />}
      {formatMessage({ id: running ? "machine.runtimeUpgrade.running" : "machine.runtimeUpgrade.action" })}
    </Button>
  );
}
