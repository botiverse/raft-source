import { useState } from "react";
import { useIntl } from "react-intl";
import { RotateCcw } from "lucide-react";
import { useAgentStore } from "../../store/agentStore";
import Banner from "../ui/Banner";
import type { MessageId } from "../../i18n/messages";
import ConfirmDialog from "../ConfirmDialog";

type ResetMode = "restart" | "session" | "full";

export default function ResetAgentDialog({
  agentId,
  agentName,
  canFullReset,
  memberRuntimeOnly = false,
  onClose,
}: {
  agentId: string;
  agentName: string;
  canFullReset: boolean;
  memberRuntimeOnly?: boolean;
  onClose: () => void;
}) {
  const { formatMessage } = useIntl();
  const [mode, setMode] = useState<ResetMode>("restart");
  const resetAgent = useAgentStore((s) => s.resetAgent);

  const handleReset = async () => {
    try {
      await resetAgent(agentId, mode);
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: { error?: string } } };
      throw new Error(
        axiosErr.response?.data?.error
          || (err instanceof Error ? err.message : formatMessage({ id: "agent.reset.failed" })),
      );
    }
  };

  const options: { mode: ResetMode; labelId: MessageId; descId: MessageId; color: string }[] = memberRuntimeOnly
    ? [
        { mode: "restart", labelId: "agent.reset.restartModel", descId: "agent.reset.restartModelDesc", color: "bg-brutal-cyan/20" },
        { mode: "session", labelId: "agent.reset.model", descId: "agent.reset.modelDesc", color: "bg-brutal-orange/20" },
      ]
    : [
        { mode: "restart", labelId: "agent.reset.restart", descId: "agent.reset.restartDesc", color: "bg-brutal-cyan/20" },
        { mode: "session", labelId: "agent.reset.session", descId: "agent.reset.sessionDesc", color: "bg-brutal-orange/20" },
        ...(canFullReset
          ? [{ mode: "full" as const, labelId: "agent.reset.full" as const, descId: "agent.reset.fullDesc" as const, color: "bg-brutal-red/20" }]
          : []),
      ];

  const selectedOption = options.find((o) => o.mode === mode)!;
  const confirmColor = mode === "full" ? "bg-brutal-red" : mode === "session" ? "bg-brutal-orange" : "bg-brutal-cyan";

  return (
    <ConfirmDialog
      title={formatMessage({ id: "agent.reset.title" }, { name: agentName })}
      maxWidthClass="max-w-md"
      plainMessage
      message={(
        <div className="space-y-3">
          <div className="space-y-3">
            {options.map((opt) => (
              <button
                key={opt.mode}
                type="button"
                onClick={() => setMode(opt.mode)}
                className={`w-full text-left border-2 p-4 transition-colors ${
                  mode === opt.mode
                    ? `border-black ${opt.color} shadow-brutal-sm`
                    : "border-black/30 hover:border-black"
                }`}
              >
                <div className="font-bold text-sm uppercase">{formatMessage({ id: opt.labelId })}</div>
                <p className="mt-1 text-xs text-black/60">{formatMessage({ id: opt.descId })}</p>
              </button>
            ))}
          </div>
          {mode === "full" && (
            <Banner intent="warning" density="sm" withIcon className="font-bold">
              {formatMessage({ id: "agent.reset.fullWarning" })}
            </Banner>
          )}
        </div>
      )}
      chromeLocale="active"
      confirmLabel={formatMessage({ id: selectedOption.labelId })}
      loadingLabel={formatMessage({ id: "agent.reset.loading" })}
      confirmIcon={<RotateCcw size={14} />}
      confirmColor={confirmColor}
      onConfirm={handleReset}
      onClose={onClose}
    />
  );
}
