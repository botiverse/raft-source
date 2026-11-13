import { useCallback } from "react";
import { useIntl } from "react-intl";
import { Button } from "@botiverse/raft-ui";

// Banner action for one recoverable upload. Own component so each
// row binds its id in a memoized handler (react-perf: no inline closures).
export function RecoverableUploadCancelButton({
  uploadId,
  filename,
  onCancel,
}: {
  uploadId: string;
  filename: string;
  onCancel: (uploadId: string) => Promise<void>;
}) {
  const { formatMessage } = useIntl();
  const handleClick = useCallback(() => { void onCancel(uploadId); }, [onCancel, uploadId]);
  return (
    <Button
      type="button"
      size="md"
      variant="outline"
      className="shrink-0"
      onClick={handleClick}
      aria-label={formatMessage({ id: "message.composer.cancelRecoveredUploadLabel" }, { file: filename })}
    >
      {formatMessage({ id: "message.composer.cancelRecoveredUpload" })}
    </Button>
  );
}
