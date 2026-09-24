import { useState, useRef, useEffect } from "react";
import { useIntl } from "react-intl";
import DialogCard from "../ui/DialogCard";
import Banner from "../ui/Banner";
import Button from "../ui/Button";
import api from "../../api/client";

type Phase = "confirm" | "stopped" | "resuming";

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
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (phase === "stopped" && textareaRef.current) {
      textareaRef.current.focus({ preventScroll: true });
    }
  }, [phase]);

  const handleStop = async () => {
    setStopping(true);
    try {
      await api.post(`/channels/${channelId}/stop-all-agents`);
      setPhase("stopped");
    } catch {
      // stay on confirm phase
    } finally {
      setStopping(false);
    }
  };

  const handleResume = async () => {
    if (!guidance.trim()) return;
    setResuming(true);
    try {
      const prompt = `[SOS] The user has emergency-stopped all agents in #${channelName} because they were going off-track. Here is the user's correction and new guidance:\n\n${guidance.trim()}\n\nRead this carefully, acknowledge the correction, and adjust your approach accordingly. Use check_messages and read_history to understand the current state before taking any action.`;
      await api.post(`/channels/${channelId}/resume-all-agents`, { prompt });
      onClose();
    } catch {
      setResuming(false);
    }
  };

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
            <p className="mb-5 text-sm leading-relaxed text-black/75" data-slot="sos-dialog-content">
              {formatMessage({ id: "message.sos.confirmWarning" }, { channel: channelName })}
            </p>

            {/* Actions */}
            <div className="flex justify-end gap-3">
              <Button
                onClick={onClose}
                size="sm"
                tone="white"
              >
                {formatMessage({ id: "common.confirm.cancel" })}
              </Button>
              <Button
                onClick={handleStop}
                disabled={stopping}
                size="sm"
                tone="orange"
                className="disabled:cursor-not-allowed disabled:opacity-50"
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
            <p className="mb-2 text-sm">
              {formatMessage({ id: "message.sos.guidanceHint" })}
            </p>
            <textarea
              ref={textareaRef}
              value={guidance}
              onChange={(e) => setGuidance(e.target.value)}
              placeholder={formatMessage({ id: "message.sos.guidancePlaceholder" })}
              className="input-brutal mb-4 w-full resize-none p-3 text-sm"
              rows={4}
              disabled={resuming}
            />
            <div className="flex justify-end gap-3">
              <Button
                onClick={onClose}
                size="sm"
                tone="white"
                disabled={resuming}
              >
                {formatMessage({ id: "message.sos.keepStopped" })}
              </Button>
              <Button
                onClick={handleResume}
                disabled={!guidance.trim() || resuming}
                size="sm"
                tone="lime"
                className="disabled:cursor-not-allowed disabled:opacity-50"
              >
                {resuming
                  ? formatMessage({ id: "message.sos.resuming" })
                  : formatMessage({ id: "message.sos.resumeAll" })}
              </Button>
            </div>
          </>
        )}
    </DialogCard>
  );
}
