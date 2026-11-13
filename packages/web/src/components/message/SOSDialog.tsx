import { Textarea, Button } from "@botiverse/raft-ui";
import { useCallback, useState, useRef, useEffect } from "react";
import type { ChangeEvent } from "react";
import { useIntl } from "react-intl";
import DialogCard from "../ui/DialogCard";
import Banner from "../ui/Banner";
import api from "../../api/client";
import { DialogActions, DialogCommit } from "../ui/NarrowDialog";

type Phase = "confirm" | "stopped" | "resuming";

interface ResumeAllResponse {
  results?: Array<{ agentId: string; ok: boolean; reason?: string }>;
}

/** Agents the resume did not reach: still starting (try again shortly) or failed. */
interface ResumeShortfall {
  starting: number;
  failed: number;
  /** A retry names only these, so agents that already got the guidance are not sent it again. */
  agentIds: string[];
}

export default function SOSDialog({
  channelId,
  channelName,
  onClose,
}: {
  channelId: string;
  channelName: string;
  onClose: () => void;
}) {
  const { formatMessage } = useIntl();
  const [phase, setPhase] = useState<Phase>("confirm");
  const [stopping, setStopping] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [guidance, setGuidance] = useState("");
  const [resumeShortfall, setResumeShortfall] = useState<ResumeShortfall | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (phase === "stopped" && textareaRef.current) {
      textareaRef.current.focus({ preventScroll: true });
    }
  }, [phase]);

  const handleStop = useCallback(async () => {
    setStopping(true);
    try {
      await api.post(`/channels/${channelId}/stop-all-agents`);
      setPhase("stopped");
    } catch {
      // stay on confirm phase
    } finally {
      setStopping(false);
    }
  }, [channelId]);

  const handleResume = useCallback(async () => {
    if (!guidance.trim()) return;
    setResuming(true);
    try {
      const prompt = `[SOS] The user has emergency-stopped all agents in #${channelName} because they were going off-track. Here is the user's correction and new guidance:\n\n${guidance.trim()}\n\nRead this carefully, acknowledge the correction, and adjust your approach accordingly. Use check_messages and read_history to understand the current state before taking any action.`;
      const { data } = await api.post<ResumeAllResponse>(
        `/channels/${channelId}/resume-all-agents`,
        resumeShortfall ? { prompt, agentIds: resumeShortfall.agentIds } : { prompt },
      );
      // The server reports each agent; one it could not start did not get the
      // guidance, so keep the dialog open (with the text) instead of closing.
      const missed = (data?.results ?? []).filter((result) => !result.ok);
      if (missed.length === 0) {
        onClose();
        return;
      }
      const starting = missed.filter((result) => result.reason === "start_in_flight").length;
      setResumeShortfall({ starting, failed: missed.length - starting, agentIds: missed.map((result) => result.agentId) });
      setResuming(false);
    } catch {
      setResuming(false);
    }
  }, [channelId, channelName, guidance, onClose, resumeShortfall]);

  const handleGuidanceChange = useCallback((event: ChangeEvent<HTMLTextAreaElement>) => {
    setGuidance(event.target.value);
  }, []);

  return (
    <DialogCard
      title={phase === "confirm"
        ? formatMessage({ id: "message.sos.stopAllAgents" })
        : formatMessage({ id: "message.sos.agentsStopped" })}
      onClose={onClose}
      maxWidthClass="max-w-sm"
    >

        {phase === "confirm" && (
          <>
            <p className="mb-5 text-subhead text-foreground-muted" data-slot="sos-dialog-content">
              {formatMessage({ id: "message.sos.confirmWarning" }, { channel: channelName })}
            </p>

            {/* Actions */}
            <div className="flex justify-end gap-3">
              <Button
                onClick={onClose}
                size="lg"
                variant="ghost"
              >
                {formatMessage({ id: "common.confirm.cancel" })}
              </Button>
              <Button
                onClick={handleStop}
                disabled={stopping}
                size="lg"
                variant="warning"
              >
                {stopping
                  ? formatMessage({ id: "message.sos.stopping" })
                  : formatMessage({ id: "message.sos.stopAction" })}
              </Button>
            </div>
          </>
        )}

        {(phase === "stopped" || phase === "resuming") && (
          <>
            <Banner intent="success" density="sm" className="mb-3 font-bold">
              {formatMessage({ id: "message.sos.allStopped" })}
            </Banner>
            <p className="mb-2 text-subhead text-foreground-muted">
              {formatMessage({ id: "message.sos.guidanceHint" })}
            </p>
            {resumeShortfall && (
              <Banner intent="warning" density="sm" className="mb-3" data-slot="sos-resume-shortfall">
                {resumeShortfall.starting > 0 && (
                  <div>
                    {formatMessage({ id: "message.sos.resumeStillStarting" }, { count: resumeShortfall.starting })}
                  </div>
                )}
                {resumeShortfall.failed > 0 && (
                  <div>
                    {formatMessage({ id: "message.sos.resumeFailed" }, { count: resumeShortfall.failed })}
                  </div>
                )}
              </Banner>
            )}
            <Textarea
              ref={textareaRef}
              value={guidance}
              onChange={handleGuidanceChange}
              placeholder={formatMessage({ id: "message.sos.guidancePlaceholder" })}
              className="mb-4 w-full resize-none"
              rows={4}
              disabled={resuming}
            />
            <DialogActions className="flex justify-end gap-2">
              <Button
                onClick={onClose}
                size="lg"
                variant="ghost"
                disabled={resuming}
              >
                {formatMessage({ id: "message.sos.keepStopped" })}
              </Button>
              <DialogCommit>
                {(inHead) => (
                  <Button
                    onClick={handleResume}
                    disabled={!guidance.trim() || resuming}
                    size={inHead ? "md" : "lg"}
                    variant="primary"
                  >
                    {resuming
                      ? formatMessage({ id: "message.sos.resuming" })
                      : formatMessage({ id: "message.sos.resumeAll" })}
                  </Button>
                )}
              </DialogCommit>
            </DialogActions>
          </>
        )}
    </DialogCard>
  );
}
