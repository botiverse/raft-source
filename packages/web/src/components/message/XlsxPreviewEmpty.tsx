import { Sheet } from "lucide-react";
import { useIntl } from "react-intl";
import EmptyState from "../ui/EmptyState";

/** A spreadsheet preview with no sheet, or a sheet with no cells: the DS empty state. */
export function XlsxPreviewEmpty({ className }: { className?: string }) {
  const { formatMessage } = useIntl();
  return (
    <EmptyState
      className={className}
      icon={<Sheet />}
      title={formatMessage({ id: "message.messageItem.xlsxEmpty" })}
      data-testid="xlsx-preview-empty"
    />
  );
}
