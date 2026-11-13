import { useCallback } from "react";
import { useIntl } from "react-intl";
import { Button } from "@botiverse/raft-ui";
import Banner from "../../components/ui/Banner";

// One failed upload. The file name is the title, the reason (and how far it
// got) the description. With Retry, the banner removes the file with a ghost
// Remove before it; without, with the × (Raft Design System › Banner).
// raft-ui's BannerAction places the actions. Own component so each banner
// binds its id in memoized handlers (react-perf: no inline closures).
export function UploadFailureBanner({
  fileId,
  fileName,
  error,
  progress,
  canRetry,
  onRetry,
  onRemove,
}: {
  fileId: string;
  fileName: string;
  error: string | undefined;
  progress: number;
  canRetry: boolean;
  onRetry: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  const { formatMessage } = useIntl();
  const handleRetry = useCallback(() => onRetry(fileId), [onRetry, fileId]);
  const handleRemove = useCallback(() => onRemove(fileId), [onRemove, fileId]);
  const removeLabel = formatMessage({ id: "message.composer.removeAttachment" }, { file: fileName });
  return (
    <Banner
      intent="warning"
      density="sm"
      role="alert"
      title={<span className="break-all">{fileName}</span>}
      actions={canRetry ? (
        <>
          <Button type="button" size="md" variant="ghost" onClick={handleRemove} aria-label={removeLabel}>
            {formatMessage({ id: "message.composer.removeFailedUpload" })}
          </Button>
          <Button
            type="button"
            size="md"
            variant="default"
            onClick={handleRetry}
            aria-label={formatMessage({ id: "message.composer.retryUploadAttachment" }, { file: fileName })}
          >
            {formatMessage({ id: "message.composer.tapToRetry" })}
          </Button>
        </>
      ) : undefined}
      onClose={canRetry ? undefined : handleRemove}
      closeLabel={removeLabel}
    >
      <span className="block break-words">
        {error || formatMessage({ id: "message.composer.uploadFailed" })}
      </span>
      {progress > 0 && (
        <span className="block">
          {formatMessage({ id: "message.composer.uploadProgressSent" }, { progress })}
        </span>
      )}
    </Banner>
  );
}
