import { useCallback, useState } from "react";
import { useIntl } from "react-intl";
import { RotateCcw } from "lucide-react";
import { RadioGroup, RadioGroupItem } from "@botiverse/raft-ui";
import { useAgentStore } from "../../store/agentStore";
import Banner from "../ui/Banner";
import type { MessageId } from "../../i18n/messages";
import ConfirmDialog from "../ConfirmDialog";

type ResetMode = "restart" | "session" | "full";

type ResetOption = { mode: ResetMode; labelId: MessageId; descId: MessageId };

const MEMBER_RUNTIME_OPTIONS: ResetOption[] = [
  { mode: "restart", labelId: "agent.reset.restartModel", descId: "agent.reset.restartModelDesc" },
  { mode: "session", labelId: "agent.reset.model", descId: "agent.reset.modelDesc" },
];
const STANDARD_OPTIONS: ResetOption[] = [
  { mode: "restart", labelId: "agent.reset.restart", descId: "agent.reset.restartDesc" },
  { mode: "session", labelId: "agent.reset.session", descId: "agent.reset.sessionDesc" },
];
const FULL_RESET_OPTION: ResetOption = { mode: "full", labelId: "agent.reset.full", descId: "agent.reset.fullDesc" };

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

  const handleReset = useCallback(async () => {
    try {
      await resetAgent(agentId, mode);
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: { error?: string } } };
      throw new Error(
        axiosErr.response?.data?.error
          || (err instanceof Error ? err.message : formatMessage({ id: "agent.reset.failed" })),
      );
    }
  }, [resetAgent, agentId, mode, formatMessage]);

  const handleModeChange = useCallback((value: string) => setMode(value as ResetMode), []);

  const options: ResetOption[] = memberRuntimeOnly
    ? MEMBER_RUNTIME_OPTIONS
    : canFullReset
      ? [...STANDARD_OPTIONS, FULL_RESET_OPTION]
      : STANDARD_OPTIONS;

  const selectedOption = options.find((o) => o.mode === mode)!;
  // The confirm colour states the consequence (DS Dialog): restart and session
  // reset interrupt the agent but it comes back, so they are the orange
  // `warning`; the full reset deletes the workspace and cannot be undone, so it
  // is the red `danger`, paired with the red-soft destructive banner below.
  const confirmVariant = mode === "full" ? "danger" : "warning";

  return (
    <ConfirmDialog
      title={formatMessage({ id: "agent.reset.title" }, { name: agentName })}
      maxWidthClass="max-w-md"
      plainMessage
      message={(
        <div className="stack-y-3">
          {/* Standard rui RadioGroup. These were three hand-rolled <button>s
              carrying their own border/tint/hover rules, which is why they read
              as heavy panels (@Artea, task #660). The group
              is a single-select list, so the radio semantics come free: arrow
              keys, one tab stop, and a real checked state for assistive tech. */}
          <RadioGroup
            value={mode}
            onValueChange={handleModeChange}
            aria-label={formatMessage({ id: "agent.reset.title" }, { name: agentName })}
            className="gap-0"
          >
            {options.map((opt) => (
              <label key={opt.mode} className="flex min-h-11 items-start gap-3 py-3">
                <RadioGroupItem
                  value={opt.mode}
                  className="shrink-0"
                  data-testid={`agent-reset-option-${opt.mode}`}
                />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-subhead font-semibold text-foreground">{formatMessage({ id: opt.labelId })}</span>
                  <span className="text-footnote font-normal text-foreground-muted">{formatMessage({ id: opt.descId })}</span>
                </span>
              </label>
            ))}
          </RadioGroup>
          {mode === "full" && (
            <Banner intent="destructive" density="sm" withIcon>
              {formatMessage({ id: "agent.reset.fullWarning" })}
            </Banner>
          )}
        </div>
      )}
      chromeLocale="active"
      confirmLabel={formatMessage({ id: selectedOption.labelId })}
      loadingLabel={formatMessage({ id: "agent.reset.loading" })}
      confirmIcon={<RotateCcw size={14} />}
      confirmVariant={confirmVariant}
      onConfirm={handleReset}
      onClose={onClose}
    />
  );
}
