import { getRuntimeDisplayName } from "@botiverse/raft-shared";
import { useIntl } from "react-intl";
import { runtimeInstallCopy } from "./runtimeInstallCopy";
import type { RuntimeInstallState } from "./runtimeInstallCopy";

/**
 * What the last Install on this Computer is doing or learned, one plain
 * sentence under the runtime chips (the chip itself moves to the detected
 * ones once the Computer finds the runtime): "Installing…" while the
 * installer runs, then `runtimeInstallCopy`; nothing otherwise. Ink once it
 * helped, orange-strong when the person has something to do (Raft DS: a
 * problem is orange, never red).
 */
export function RuntimeInstallOutcome({ state }: { state: RuntimeInstallState }) {
  const { formatMessage } = useIntl();
  if (state.kind === "running") {
    return (
      <p className="w-full text-caption text-foreground-muted" role="status" data-testid="runtime-install-outcome">
        {formatMessage({ id: "machine.runtimeInstall.runningStatus" }, { runtime: getRuntimeDisplayName(state.runtime) })}
      </p>
    );
  }
  const copy = runtimeInstallCopy(state);
  if (!copy || state.kind === "idle") return null;
  return (
    <p
      className={copy.tone === "success" ? "w-full text-caption text-foreground" : "w-full text-caption text-warning-strong"}
      role="status"
      data-testid="runtime-install-outcome"
    >
      {formatMessage({ id: copy.id }, { runtime: getRuntimeDisplayName(state.runtime), ...copy.values })}
    </p>
  );
}
