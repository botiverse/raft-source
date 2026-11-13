import { Button } from "@botiverse/raft-ui";
import Tooltip from "../ui/Tooltip";
import { Trash2 } from "lucide-react";
import { useCallback } from "react";
import { useIntl } from "react-intl";

export function WorkspaceDeleteButton({
  directoryName,
  onRequestDelete,
}: {
  directoryName: string;
  onRequestDelete: (directoryName: string) => void;
}) {
  const { formatMessage } = useIntl();
  const handleClick = useCallback(() => onRequestDelete(directoryName), [directoryName, onRequestDelete]);
  // The row only asks; the red, irreversible button is in the confirm dialog
  // it opens. An icon button alone in content carries the ink line (Raft DS).
  return (
    <Tooltip content={formatMessage({ id: "machine.detail.deleteWorkspace" })}>
    <Button size="icon-md"
      variant="outline"
      onClick={handleClick}
      className="shrink-0"
      aria-label={formatMessage({ id: "machine.detail.deleteWorkspace" })}
    >
      <Trash2 size={16} />
    </Button>
    </Tooltip>
  );
}
