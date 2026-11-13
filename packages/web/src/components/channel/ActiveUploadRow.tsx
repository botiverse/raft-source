import { useCallback } from "react";
import { FileUp, X } from "lucide-react";
import { useIntl } from "react-intl";
import type { RecoveryView } from "../../utils/directAttachmentUpload";
import { Button, Separator } from "@botiverse/raft-ui";
import Tooltip from "../ui/Tooltip";

export function ActiveUploadRow({
  upload,
  separated = false,
  cancelBusy,
  onOpenChannel,
  onCancel,
}: {
  upload: RecoveryView;
  separated?: boolean;
  cancelBusy: boolean;
  onOpenChannel: () => void;
  onCancel: (uploadId: string) => void;
}) {
  const { formatMessage } = useIntl();
  const { uploadId } = upload;
  const handleCancel = useCallback(() => onCancel(uploadId), [onCancel, uploadId]);

  return (
    <li data-testid={`channel-settings-joint-upload-${uploadId}`}>
      {separated ? <Separator className="mb-2" /> : null}
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <Tooltip content={upload.filename}>
          <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-callout font-semibold">
            <FileUp size={16} aria-hidden="true" className="shrink-0" />
            <span className="truncate">{upload.filename}</span>
          </span>
        </Tooltip>
        <div className="flex shrink-0 flex-wrap justify-end gap-2">
          <Button
            type="button"
            size="md"
            variant="outline"
            onClick={onOpenChannel}
            data-testid={`channel-settings-joint-upload-open-${uploadId}`}
          >
            {formatMessage({ id: "channel.edit.continueUpload" })}
          </Button>
          <Button
            type="button"
            size="md"
            variant="outline"
            onClick={handleCancel}
            disabled={cancelBusy}
            data-testid={`channel-settings-joint-upload-cancel-${uploadId}`}
          >
            <X size={16} aria-hidden="true" />
            {cancelBusy
              ? formatMessage({ id: "channel.edit.cancelingUpload" })
              : formatMessage({ id: "channel.edit.cancelUpload" })}
          </Button>
        </div>
      </div>
    </li>
  );
}
