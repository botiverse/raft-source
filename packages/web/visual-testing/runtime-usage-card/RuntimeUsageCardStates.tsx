import type { RuntimeAccountUsageSnapshot, RuntimeAuthStatus, RuntimeUpdateCheck } from "@botiverse/raft-shared";
import { RuntimeUsageSurface } from "../../src/components/machine/RuntimeUsageSurface";
import type { SurfaceAuth, SurfaceLimitReset } from "../../src/components/machine/RuntimeUsageSurface";
import type { RuntimeUpgradeState } from "../../src/features/computer/runtimeUpgradeOutcomeCopy";
import type { RuntimeAuthView } from "../../src/utils/runtimeAuthClient";

// Fixture states of the runtime usage card (#oar-raft:3a3f8fc1), for
// screenshots (runtime-usage-card.shot.mjs): healthy, nearly used up, used up,
// an update available, after an Upgrade, signed out.

type Account = RuntimeAccountUsageSnapshot["accounts"][number];
const noop = () => {};

const VIEW: RuntimeAuthView = {
  status: { collectedAt: new Date().toISOString(), runtimes: {} },
  availability: "ok",
  runtimes: ["codex", "grok"],
  logoutRuntimes: ["codex", "grok"],
  canAct: true,
  runtimeUpgrade: true,
  upgradableRuntimes: ["codex", "grok"],
};

function codexAccount(usedRatio: number, credits: Account["credits"] = { available: true, balance: "1240" }): Account {
  const usedUp = usedRatio >= 1;
  return {
    accountKey: "c".repeat(64),
    planLabel: "pro",
    maskedLabel: "x*****n@botiverse.dev",
    health: usedUp ? "rate_limited" : "ok",
    windows: [{ id: "w", label: "Codex · 1 week", status: usedUp ? "limit_reached" : "ok", usedRatio, resetsAt: new Date(Date.now() + 6 * 86_400_000 + 3_600_000).toISOString() }],
    limitResetsAvailable: 1,
    credits,
  };
}

const GROK: Account = {
  accountKey: "g".repeat(64),
  planLabel: "SuperGrok",
  maskedLabel: "xxc*****2f@gmail.com",
  health: "ok",
  windows: [{ id: "w", label: "Weekly included usage", status: "ok", usedRatio: 0.02, resetsAt: new Date(Date.now() + 2 * 86_400_000 + 3_600_000).toISOString() }],
};

function snapshot(provider: "codex" | "grok", account: Account): RuntimeAccountUsageSnapshot {
  return {
    protocolVersion: 2,
    provider,
    collectedAt: new Date(Date.now() - 7 * 60_000).toISOString(),
    staleAfter: new Date(Date.now() + 3_600_000).toISOString(),
    collectorVersion: "fixture",
    accounts: [account],
  };
}

interface Case {
  runtime: "codex" | "grok";
  account: Account;
  version: string;
  status?: RuntimeAuthStatus;
  upgrade?: RuntimeUpgradeState;
  update?: RuntimeUpdateCheck | null;
  limitReset?: SurfaceLimitReset | null;
}

const CHECKED_AT = new Date().toISOString();
const CASES: Record<string, Case> = {
  healthy: { runtime: "codex", account: codexAccount(0.56), version: "0.170.0", update: { kind: "ok", installed: "0.170.0", latest: "0.170.0", updateAvailable: false, checkedAt: CHECKED_AT } },
  "nearly-used-up": { runtime: "codex", account: codexAccount(0.86), version: "0.170.0", update: { kind: "ok", installed: "0.170.0", latest: "0.170.0", updateAvailable: false, checkedAt: CHECKED_AT }, limitReset: { primary: false, onUse: noop } },
  "used-up": { runtime: "codex", account: codexAccount(1, { available: false }), version: "0.170.0", update: { kind: "ok", installed: "0.170.0", latest: "0.170.0", updateAvailable: false, checkedAt: CHECKED_AT }, limitReset: { primary: true, onUse: noop } },
  "update-available": { runtime: "grok", account: GROK, version: "1.0.88", update: { kind: "ok", installed: "1.0.88", latest: "1.0.89", updateAvailable: true, checkedAt: CHECKED_AT } },
  upgraded: { runtime: "codex", account: codexAccount(0.56), version: "0.170.0", upgrade: { kind: "done", result: { kind: "upgraded", from: "0.162.0", to: "0.170.0" } } },
  "signed-out": { runtime: "codex", account: codexAccount(0.56), version: "0.170.0", status: { kind: "logged_out" }, update: { kind: "ok", installed: "0.170.0", latest: "0.170.0", updateAvailable: false, checkedAt: CHECKED_AT } },
};

function authOf(c: Case): SurfaceAuth {
  return {
    runtime: c.runtime,
    status: c.status ?? { kind: "logged_in" },
    view: VIEW,
    onSignIn: noop,
    onSignOut: noop,
    onConnectProvider: noop,
    onSignOutProvider: noop,
    upgrade: { state: c.upgrade ?? { kind: "idle" }, onUpgrade: noop },
    update: c.update ?? null,
  };
}

// Built once per case, outside render.
const DRAWN = Object.fromEntries(Object.entries(CASES).map(([id, c]) => [id, {
  c,
  auth: authOf(c),
  result: { state: "fresh" as const, snapshot: snapshot(c.runtime, c.account) },
}]));

export function RuntimeUsageCardStates({ caseId }: { caseId: string }) {
  const { c, auth, result } = DRAWN[caseId] ?? DRAWN.healthy!;
  return (
    <div className="flex min-h-screen items-start justify-center bg-fill-muted p-6">
      <div data-shot="scene" className="w-[375px] overflow-hidden rounded-xl border border-line-seam bg-layer-popover shadow-float">
        <RuntimeUsageSurface
          runtimeId={c.runtime}
          provider={c.runtime}
          runtimeVersion={c.version}
          result={result}
          loading={false}
          loadError={false}
          refreshState="idle"
          cooldownLeftMs={0}
          onRefresh={noop}
          onClose={noop}
          auth={auth}
          runtimeName={c.runtime === "codex" ? "Codex CLI" : "Grok Build"}
          limitReset={c.limitReset ?? null}
          note={null}
        />
      </div>
    </div>
  );
}
