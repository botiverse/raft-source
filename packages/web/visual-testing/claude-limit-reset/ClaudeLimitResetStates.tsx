import type { RuntimeAccountUsageSnapshot, RuntimeLimitResetIdempotencyKey, RuntimeLimitResetResult, RuntimeLimitResetsReadResult } from "@botiverse/raft-shared";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import { RuntimeUsageSurface } from "../../src/components/machine/RuntimeUsageSurface";
import type { SurfaceClaudeLimitReset } from "../../src/components/machine/RuntimeUsageSurface";
import { ClaudeLimitResetConfirmDialog, ClaudeLimitResetsDialog } from "../../src/features/computer/ClaudeLimitResetsDialog";
import { claudeLimitResetKeptNote, claudeLimitResetNote } from "../../src/features/computer/claudeLimitResetCopy";
import type { MessageId } from "../../src/i18n/messages/en";
import { RuntimeAuthClient } from "../../src/utils/runtimeAuthClient";
import type { RuntimeAuthSocket } from "../../src/utils/runtimeAuthClient";

// Fixture states of the Claude limit-reset card and dialogs, for screenshots
// (claude-limit-reset.shot.mjs). The card is RuntimeUsageSurface as the usage
// card draws it; the dialogs are the real ones over a fake RuntimeAuthClient.

const EMAIL = "tea****r@example.com";
const KEY = "0f6b1f8e-5c3a-4c55-9c1e-6a7b8c9d0e1f" as RuntimeLimitResetIdempotencyKey;

function usage(atFiveHourLimit: boolean): RuntimeAccountUsageSnapshot {
  return {
    protocolVersion: 2,
    provider: "claude",
    collectedAt: new Date(Date.now() - 60_000).toISOString(),
    staleAfter: new Date(Date.now() + 3_600_000).toISOString(),
    collectorVersion: "fixture",
    accounts: [{
      accountKey: "c".repeat(64),
      maskedLabel: EMAIL,
      planLabel: "Max",
      health: atFiveHourLimit ? "rate_limited" : "ok",
      windows: [
        { id: "session", label: "Current session", status: atFiveHourLimit ? "limit_reached" : "ok", usedRatio: atFiveHourLimit ? 1 : 0.42, resetsAt: new Date(Date.now() + 2 * 3_600_000).toISOString() },
        { id: "week", label: "Current week (all models)", status: "ok", usedRatio: 0.63, resetsAt: new Date(Date.now() + 4 * 86_400_000).toISOString() },
      ],
    }],
  };
}

const AT_WALL = { state: "fresh", snapshot: usage(true) } as const;
const BELOW = { state: "fresh", snapshot: usage(false) } as const;

const WEEKLY = { kind: "weekly", state: "available", resetsLeft: 1, expiresText: "Nov 26, 4:59pm" } as const;
const READ: RuntimeLimitResetsReadResult = {
  kind: "read",
  resets: [
    { kind: "five_hour", state: "available", resetsLeft: 2, expiresText: "Nov 19, 4:59pm" },
    WEEKLY,
    { kind: "fable", state: "available", resetsLeft: 3, expiresText: "Nov 22, 4:59pm" },
    { kind: "full", state: "none" },
  ],
};

const SOCKET = { on() { return this; }, off() { return this; } } as unknown as RuntimeAuthSocket;
const SOCKETS = { current: () => SOCKET, onReplaced: () => () => {} };

// `read: null`: the read never answers (the "This takes a moment" state).
function client(redeem: () => Promise<unknown>, read: RuntimeLimitResetsReadResult | null = READ): RuntimeAuthClient {
  return new RuntimeAuthClient({
    get: async <T,>() => ({}) as T,
    post: async <T,>(url: string) => (url.endsWith("/limit-resets/read")
      ? (read ? { result: read } : await new Promise(() => {}))
      : await redeem()) as T,
  }, SOCKETS);
}

const OK_CLIENT = client(async () => ({ result: { kind: "reset" }, snapshot: null }));
const READING_CLIENT = client(async () => ({ result: { kind: "reset" }, snapshot: null }), null);
const RATE_LIMITED_CLIENT = client(async () => {
  throw Object.assign(new Error("rate_limited"), { response: { status: 429, data: { code: "rate_limited" } } });
});

function noop() {}

const WALL_ACTIONS: SurfaceClaudeLimitReset = { atFiveHourLimit: true, canUse: true, onOpen: noop };
const BELOW_ACTIONS: SurfaceClaudeLimitReset = { atFiveHourLimit: false, canUse: true, onOpen: noop };
const VIEW_ONLY_ACTIONS: SurfaceClaudeLimitReset = { atFiveHourLimit: false, canUse: false, onOpen: noop };

const NOTE_RESULTS: Record<string, RuntimeLimitResetResult> = {
  "result-success": { kind: "reset" },
  "result-five-hour-spent": { kind: "unknown", fiveHourSpent: true },
  "result-unknown": { kind: "unknown" },
};

// Lines a read ends with (claudeLimitResetReadStep).
const READ_NOTES: Record<string, MessageId> = {
  "legacy-reset": "machine.runtimeUsage.claudeReset.legacyReset",
  "legacy-used": "machine.runtimeUsage.claudeReset.legacyUsed",
  "none-to-use": "machine.runtimeUsage.claudeReset.noneToUse",
  "none-at-limit": "machine.runtimeUsage.claudeReset.noneAtLimit",
};

function Card({ atWall, note, actions }: { atWall: boolean; note: string | null; actions?: SurfaceClaudeLimitReset }) {
  return (
    <div data-shot="scene" className="w-[390px] rounded-lg border border-line-seam bg-layer-popover shadow-float">
      <RuntimeUsageSurface
        runtimeId="claude"
        provider="claude"
        runtimeVersion="2.1.322"
        result={atWall ? AT_WALL : BELOW}
        loading={false}
        loadError={false}
        refreshState="idle"
        cooldownLeftMs={0}
        onRefresh={noop}
        auth={null}
        runtimeName="Claude Code"
        limitReset={null}
        claudeLimitReset={actions ?? (atWall ? WALL_ACTIONS : BELOW_ACTIONS)}
        note={note}
      />
    </div>
  );
}

export function ClaudeLimitResetStates({ caseId }: { caseId: string }) {
  const { formatMessage } = useIntl();
  const page = (body: ReactNode) => <div className="min-h-screen bg-background p-10">{body}</div>;
  switch (caseId) {
    case "card-wall": return page(<Card atWall note={null} />);
    case "card-below": return page(<Card atWall={false} note={null} />);
    case "card-view-only": return page(<Card atWall={false} note={null} actions={VIEW_ONLY_ACTIONS} />);
    case "reading":
      return page(<ClaudeLimitResetsDialog serverId="s" machineId="m" atFiveHourLimit={false} client={READING_CLIENT} onUse={noop} onNote={noop} onClose={noop} />);
    case "choose":
      // Below the limit, several kinds usable: "Which reset do you want to use?".
      return page(<ClaudeLimitResetsDialog serverId="s" machineId="m" atFiveHourLimit={false} client={OK_CLIENT} onUse={noop} onNote={noop} onClose={noop} />);
    case "list-read-only":
      // An owner or admin who did not connect the Computer: the same read, nothing to use.
      return page(<ClaudeLimitResetsDialog serverId="s" machineId="m" atFiveHourLimit={false} canUse={false} client={OK_CLIENT} onUse={noop} onNote={noop} onClose={noop} />);
    case "confirm":
      return page(<ClaudeLimitResetConfirmDialog serverId="s" machineId="m" kind="weekly" status={WEEKLY} account={EMAIL} atFiveHourLimit={false} idempotencyKey={KEY} client={OK_CLIENT} onOutcome={noop} onClose={noop} />);
    case "result-refused":
      return page(<ClaudeLimitResetConfirmDialog serverId="s" machineId="m" kind="weekly" status={WEEKLY} account={EMAIL} atFiveHourLimit={false} idempotencyKey={KEY} client={RATE_LIMITED_CLIENT} onOutcome={noop} onClose={noop} />);
    case "result-kept":
      return page(<Card atWall={false} note={claudeLimitResetKeptNote(formatMessage, "weekly", WEEKLY)} />);
    default: {
      const readNote = READ_NOTES[caseId];
      if (readNote) return page(<Card atWall={caseId !== "none-to-use"} note={formatMessage({ id: readNote })} />);
      const result = NOTE_RESULTS[caseId] ?? NOTE_RESULTS["result-success"]!;
      return page(<Card atWall={false} note={claudeLimitResetNote(formatMessage, "weekly", result)} />);
    }
  }
}
