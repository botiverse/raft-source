import { useCallback, useEffect, useRef, useState } from "react";
import { useIntl } from "react-intl";
import api from "../../api/client";
import {
  cancelAttachmentUploadSession,
  listActiveAttachmentUploads,
} from "../../utils/directAttachmentUpload";
import type { RecoveryView } from "../../utils/directAttachmentUpload";
import { FormSection } from "@botiverse/raft-ui";
import { ActiveUploadRow } from "./ActiveUploadRow";
import {
  notifyAttachmentUploadChanged,
  subscribeAttachmentUploadChanged,
} from "../../store/attachmentUploadEvents";

type JointAttachmentUploadSectionProps = {
  uploads: RecoveryView[];
  cancelBusyId?: string | null;
  onOpenChannel: () => void;
  onCancel: (uploadId: string) => void;
};

export function useActiveAttachmentUploads(
  channelId: string,
  enabled: boolean,
) {
  const [loaded, setLoaded] = useState<{ channelId: string; uploads: RecoveryView[] }>({ channelId, uploads: [] });
  const [cancelBusyId, setCancelBusyId] = useState<string | null>(null);
  const loadedRef = useRef(loaded);
  const refreshGenerationRef = useRef(0);
  const refreshControllerRef = useRef<AbortController | null>(null);
  const canceledUploadIdsRef = useRef<Set<string>>(new Set());
  loadedRef.current = loaded;
  const publishUploads = useCallback((uploads: RecoveryView[]) => {
    const next = { channelId, uploads };
    loadedRef.current = next;
    setLoaded(next);
    return uploads;
  }, [channelId]);

  const refreshUploads = useCallback(() => {
    if (!enabled) return;
    const generation = refreshGenerationRef.current + 1;
    refreshGenerationRef.current = generation;
    refreshControllerRef.current?.abort();
    const controller = new AbortController();
    refreshControllerRef.current = controller;
    void listActiveAttachmentUploads(api, channelId, controller.signal)
      .then((nextUploads) => {
        if (!controller.signal.aborted && refreshGenerationRef.current === generation) {
          const serverIds = new Set(nextUploads.map((upload) => upload.uploadId));
          for (const uploadId of canceledUploadIdsRef.current) {
            if (!serverIds.has(uploadId)) canceledUploadIdsRef.current.delete(uploadId);
          }
          publishUploads(nextUploads.filter((upload) => !canceledUploadIdsRef.current.has(upload.uploadId)));
        }
      })
      .catch(() => {
        if (!controller.signal.aborted && refreshGenerationRef.current === generation) {
          publishUploads([]);
        }
      });
  }, [channelId, enabled, publishUploads]);

  // oxlint-disable-next-line react-doctor/no-cascading-set-state -- async external resource
  useEffect(() => {
    refreshUploads();
    const canceledUploadIds = canceledUploadIdsRef.current;
    return () => {
      refreshGenerationRef.current += 1;
      refreshControllerRef.current?.abort();
      refreshControllerRef.current = null;
      canceledUploadIds.clear();
    };
  }, [refreshUploads]);

  useEffect(() => {
    if (!enabled) return;
    return subscribeAttachmentUploadChanged((change) => {
      if (change.channelId !== channelId) return;
      if (change.kind === "canceled") {
        canceledUploadIdsRef.current.add(change.uploadId);
        setLoaded((current) => ({ ...current, uploads: current.uploads.filter((upload) => upload.uploadId !== change.uploadId) }));
        refreshUploads();
      } else {
        refreshUploads();
      }
    });
  }, [channelId, enabled, refreshUploads]);

  const cancelUpload = useCallback(async (uploadId: string): Promise<RecoveryView[]> => {
    setCancelBusyId(uploadId);
    try {
      await cancelAttachmentUploadSession(api, uploadId);
      canceledUploadIdsRef.current.add(uploadId);
      notifyAttachmentUploadChanged({ channelId, uploadId, kind: "canceled" });
      // Remove the canceled row before the follow-up read. The server's
      // lifecycle cleanup is transactional but may be observed a few ms
      // later; the Settings surface must not keep showing a file the user
      // just canceled while that read catches up.
      const optimistic = loadedRef.current.channelId === channelId
        ? loadedRef.current.uploads.filter((upload) => upload.uploadId !== uploadId)
        : [];
      publishUploads(optimistic);
      refreshUploads();
      return optimistic;
    } finally {
      setCancelBusyId((current) => current === uploadId ? null : current);
    }
  }, [channelId, publishUploads, refreshUploads]);

  const uploads = enabled && loaded.channelId === channelId ? loaded.uploads : [];
  return { uploads, cancelBusyId, cancelUpload };
}

/**
 * Recovery surface for uploads that outlive the composer which created them.
 *
 * A direct upload cannot be resumed from Settings because the original File
 * object is intentionally not persisted. Opening the channel hands control
 * back to the owning composer (which may still have the File); cancellation is
 * always available here and is a real server-side delete, not just a UI hide.
 */
export default function JointAttachmentUploadSection({
  uploads,
  cancelBusyId = null,
  onOpenChannel,
  onCancel,
}: JointAttachmentUploadSectionProps) {
  const { formatMessage } = useIntl();

  if (uploads.length === 0) return null;

  return (
    <FormSection
      data-testid="channel-settings-joint-uploads-section"
      title={formatMessage({ id: "channel.edit.activeUploadsTitle" })}
      description={formatMessage({ id: "channel.edit.activeUploadsDescription" })}
    >
      {/* The uploads are data (file names and their actions), not a banner's message: a list of their own under
          the section's line, which says what to do (HelperText step 1). */}
      <ul className="m-0 stack-y-2 p-0" data-testid="channel-settings-joint-uploads-list">
        {uploads.map((upload, index) => (
          <ActiveUploadRow
            key={upload.uploadId}
            upload={upload}
            separated={index > 0}
            cancelBusy={cancelBusyId === upload.uploadId}
            onOpenChannel={onOpenChannel}
            onCancel={onCancel}
          />
        ))}
      </ul>
    </FormSection>
  );
}
