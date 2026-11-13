import { useMemo } from "react";
import { useIntl } from "react-intl";
import type { RuntimeSelectListAction } from "./RuntimeConfigFields";

/**
 * The Show All Supported / Show Installed Only row at the end of a runtime
 * picker's list (RuntimeSelectListActionRow), when there are not-installed
 * runtimes to show or hide.
 */
export function useRuntimeShowAllAction(
  canToggle: boolean,
  showAll: boolean,
  onShowAllChange: (showAll: boolean) => void,
): RuntimeSelectListAction | undefined {
  const { formatMessage } = useIntl();
  return useMemo(() => (canToggle
    ? {
        label: formatMessage({ id: showAll ? "runtime.availability.showInstalledOnly" : "runtime.availability.showAllSupported" }),
        onToggle: () => onShowAllChange(!showAll),
      }
    : undefined), [canToggle, formatMessage, onShowAllChange, showAll]);
}
