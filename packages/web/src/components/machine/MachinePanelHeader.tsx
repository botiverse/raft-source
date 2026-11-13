import { useMemo } from "react";
import { useIntl } from "react-intl";
import { X } from "lucide-react";
import { PanelAction } from "@botiverse/raft-ui";
import { useMobileBack } from "../../hooks/useAppNavigate";
import { useServerStore } from "../../store/serverStore";
import PanelHeader from "../ui/PanelHeader";
import { ComputerDeviceIcon } from "./ComputerDeviceIcon";
import type { ComputerDeviceInput } from "../../utils/computerDevice";
import { RowExpandAction } from "../layout/RowExpandAction";
import { RowMoveMenu } from "../layout/ColumnMoveMenu";

const HEADER_CONTAINER_PROPS = { "data-testid": "machine-panel-header" };

/**
 * A computer's head: its device icon and its name, as a profile's avatar and
 * name, and × when it is the side panel. Out of the detail's own download, so
 * the panel draws it from the computer the list already has while the detail
 * loads (ProfilePanel), and the head does not move when the detail arrives.
 */
export default function MachinePanelHeader({
  machine,
  onClose,
}: {
  machine: ComputerDeviceInput & { name: string };
  /** The side panel's close: the head ends with ×, and Back closes it too. */
  onClose?: () => void;
}) {
  const { formatMessage } = useIntl();
  const serverSlug = useServerStore((s) => s.current?.slug);
  // In the side panel, Back closes it (as on a profile). The phone's own
  // page, opened cold, goes back to the Computers list it belongs to (a page
  // the server tab pushes; Settings no longer lists Computers there).
  const onMobileBack = useMobileBack(onClose ?? (serverSlug ? `/s/${serverSlug}/computers` : "/"));
  const mobileBackProps = useMemo(() => ({
    "data-testid": "machine-mobile-back",
    title: formatMessage({ id: "common.announcement.back" }),
  }), [formatMessage]);

  return (
    <PanelHeader
      title={machine.name}
      icon={<ComputerDeviceIcon machine={machine} size={18} />}
      iconAlwaysVisible
      onMobileBack={onMobileBack}
      mobileBackProps={mobileBackProps}
      containerProps={HEADER_CONTAINER_PROPS}
      // Raft DS › Panel: shown buttons, then ⋯, then Close. A computer's head
      // has only Close; its actions are in the body. Named by `title`, as on
      // a person's profile.
      actions={onClose ? (
        <>
          {/* The profile's Expand (#189 rule 5), a window control against Close; none outside the planned row. */}
          <RowMoveMenu />
          <RowExpandAction />
          <PanelAction
            onClick={onClose}
            className="hidden md:flex"
            aria-label={formatMessage({ id: "common.close" })}
            title={formatMessage({ id: "common.close" })}
            data-testid="machine-panel-close"
          >
            <X size={22} aria-hidden="true" />
          </PanelAction>
        </>
      ) : undefined}
    />
  );
}
