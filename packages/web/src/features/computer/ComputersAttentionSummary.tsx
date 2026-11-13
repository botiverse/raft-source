import { TextLink } from "@botiverse/raft-ui";
import { Children, useCallback } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import { currentTimeMs } from "@botiverse/raft-shared";
import { useComputersRackFilters } from "../../store/computersRackFilterPreference";
import { useMachineStore } from "../../store/machineStore";
import type { Machine } from "../../store/machineStore";
import { useProfileStore } from "../../store/profileStore";
import { formatAttentionItem, formatWaitBackIn, readinessDoLabel } from "../../utils/readinessCopy";
import { SkeletonTextBar } from "../../components/ui/Skeleton";
import { useComputersRackRemembered, useRememberComputersRack } from "./computersRackRemembered";

const SUMMARY_CLASS = "flex flex-col gap-0.5 border-b border-line-hairline px-4 py-2 text-callout text-foreground-muted";
const LINE_CLASS = "flex min-w-0 flex-wrap items-center gap-x-1.5";

/**
 * #68: the line above the Computers list, from the server's per-Computer
 * "needs attention" summary. One item: what, where, how many agents, and the
 * action (to whoever may see the reason: it opens the Computer) or who acts
 * by name ("Olive can fix it"; by role for a guest: "The computer's owner
 * can fix it"). More: "3 computers need attention".
 * Clicking the needs-attention part applies the Needs attention filter.
 * Waits that clear by themselves get their own line: "4 agents waiting ·
 * back in 6d" (the earliest known end). Nothing without a summary (an older
 * server) or with nothing to say.
 * While the computers load, it keeps the lines it had the last time they
 * loaded on this server (computersRackRemembered), so the list below does not
 * move when they arrive: none, or a bar in each line it had.
 */
export function ComputersAttentionSummary() {
  const { formatMessage } = useIntl();
  const machines = useMachineStore((s) => s.machines);
  const machinesLoading = useMachineStore((s) => s.loading);
  const machinesLoaded = useMachineStore((s) => s.loadStatus === "loaded" && !s.loading);
  const setFilters = useComputersRackFilters((s) => s.set);
  const showAttention = useCallback(() => setFilters({ status: "attention" }), [setFilters]);
  const summarized = machines.filter((machine): machine is Machine & { attention: NonNullable<Machine["attention"]> } => Boolean(machine.attention));
  const flagged = summarized.filter((machine) => machine.attention.count > 0);
  const waitingAgents = summarized.reduce((sum, machine) => sum + machine.attention.waitingAgents, 0);
  const rememberedLines = useComputersRackRemembered("attentionLines");
  useRememberComputersRack("attentionLines", machinesLoaded ? (flagged.length > 0 ? 1 : 0) + (waitingAgents > 0 ? 1 : 0) : null);
  if (machinesLoading) return rememberedLines ? <AttentionSummarySkeleton lines={rememberedLines} /> : null;
  if (summarized.length === 0) return null;
  const waitingUntil = summarized.reduce<number | undefined>((earliest, machine) => {
    const until = machine.attention.waitingUntil;
    return until !== undefined && (earliest === undefined || until < earliest) ? until : earliest;
  }, undefined);
  if (flagged.length === 0 && waitingAgents === 0) return null;
  const single = flagged.length === 1 && flagged[0]!.attention.items.length === 1 ? { machine: flagged[0]!, item: flagged[0]!.attention.items[0]! } : null;
  const backIn = formatWaitBackIn(formatMessage, waitingUntil, currentTimeMs());

  let attentionLine: ReactNode[] | null = null;
  if (single) {
    const { title, who } = formatAttentionItem(formatMessage, single.item);
    const parts: ReactNode[] = [
      <TextLink key="what" onClick={showAttention} data-testid="computers-attention-filter">
        {formatMessage({ id: "readiness.attention.onComputer" }, { title, computer: single.machine.name })}
      </TextLink>,
    ];
    // A viewer who may not see the reason reads what it means for the agents ("2 agents can't run").
    const agentsId = single.item.code ? "machine.rack.agentCount" : "readiness.attention.agentsCantRun";
    if (single.item.agentCount > 0) parts.push(<span key="agents">{formatMessage({ id: agentsId }, { count: single.item.agentCount })}</span>);
    // Whoever may see the reason gets the way to act (on the Computer's page); anyone else, who acts.
    if (single.item.code) {
      parts.push(
        <OpenComputerLink key="do" machineId={single.machine.id}>
          {readinessDoLabel(formatMessage, single.item.action)}
        </OpenComputerLink>,
      );
    } else if (who) {
      parts.push(<span key="who">{who}</span>);
    }
    attentionLine = parts;
  } else if (flagged.length > 0) {
    attentionLine = [
      <TextLink key="count" onClick={showAttention} data-testid="computers-attention-filter">
        {formatMessage({ id: "readiness.attention.computers" }, { count: flagged.length })}
      </TextLink>,
    ];
  }

  return (
    <div className={SUMMARY_CLASS} data-testid="computers-attention-summary">
      {attentionLine ? <Dotted testId="computers-attention-line">{attentionLine}</Dotted> : null}
      {waitingAgents > 0 ? (
        <Dotted testId="computers-waiting-line">
          <span key="waiting">{formatMessage({ id: "readiness.attention.waiting" }, { count: waitingAgents })}</span>
          {backIn ? <span key="back">{backIn}</span> : null}
        </Dotted>
      ) : null}
    </div>
  );
}

/** The summary's lines while the computers load: a bar in each, in the line's own type, so each is the loaded line's height. */
function AttentionSummarySkeleton({ lines }: { lines: number }) {
  return (
    <div className={SUMMARY_CLASS} aria-hidden="true" data-testid="computers-attention-summary-loading">
      {Array.from({ length: Math.min(lines, 2) }, (_, index) => (
        <div key={index} className={LINE_CLASS}><span><SkeletonTextBar className={index === 0 ? "w-56" : "w-40"} /></span></div>
      ))}
    </div>
  );
}

/** Opens a Computer's page (the action for whoever may see the reason). */
function OpenComputerLink({ machineId, children }: { machineId: string; children: ReactNode }) {
  const openProfile = useProfileStore((s) => s.openProfile);
  const open = useCallback(() => openProfile("computer", machineId), [openProfile, machineId]);
  return <TextLink onClick={open} data-testid="computers-attention-action">{children}</TextLink>;
}

/** Parts on one line, joined by a middle dot (empty children are left out). */
function Dotted({ children, testId }: { children: ReactNode; testId: string }) {
  const parts = Children.toArray(children);
  return (
    <div className={LINE_CLASS} data-testid={testId}>
      {parts.map((part, index) => (
        <span key={index} className="contents">
          {index > 0 ? <span aria-hidden="true">·</span> : null}
          {part}
        </span>
      ))}
    </div>
  );
}
