import { useIntl } from "react-intl";

import { getMachineRunLabelDescriptor } from "../../utils/machineRunLabel";
import type { MachineRunLabelInput } from "../../utils/machineRunLabel";

/**
 * Renders a machine's run-kind label through the app catalog.
 *
 * This is the ONLY sanctioned render seam for the run label: the descriptor
 * (id + values) comes from the locale-free classifier, and the DISPLAY text is
 * formatted here via the active locale. The old bug rendered the classifier's
 * English `.text` fallback directly (Sidebar ComputerRow + Agent profile row),
 * which showed "daemon offline" in the zh UI (DOM sweep 2026-08-04). The zh
 * render test pins this seam so a revert to `.text` fails without reading
 * source.
 */
export function MachineRunLabel({ machine }: { machine: MachineRunLabelInput }) {
  const { formatMessage } = useIntl();
  const label = getMachineRunLabelDescriptor(machine);
  return <>{formatMessage({ id: label.id }, label.values)}</>;
}
