import { ANTHROPIC_VERIFICATION_PORTAL_URL, getRuntimeDisplayName, isReadinessCode } from "@botiverse/raft-shared";
import type { Readiness, ReadinessAction, ReadinessActor, ReadinessAttention, ReadinessAttentionItem } from "@botiverse/raft-shared";
import type { BadgeProps, Presence } from "@botiverse/raft-ui";
import type { IntlShape } from "react-intl";
import { useMachineStore } from "../store/machineStore";
import { rackReset } from "../components/machine/rack/rackResetText";

/**
 * #proj-raft-computer:#68: the words for a composed readiness, by code
 * (`readiness.<code>.*`). The server sends code and params only, already
 * trimmed for this viewer; a readiness with no `primary` (a viewer who may
 * not see the reason) or a code this build does not know reads the generic
 * sentence. The verification link is always the fixed portal, never one
 * from an error text.
 */
export interface ReadinessCopy {
  /** The short state: the chip's text. */
  title: string;
  /** "This Computer's problem" / "This agent's problem"; null without a reason. */
  scope: string | null;
  /** What happened and what is kept. */
  detail: string;
  /** Who fixes it; null without a reason. */
  actor: string | null;
  link: { href: string; text: string } | null;
}

/** Whether the readiness says the agent can't work now (someone must act, or it clears by itself). */
export function readinessHolds(readiness: Readiness | null | undefined): readiness is Readiness {
  return readiness?.state === "blocked" || readiness?.state === "waiting";
}

/**
 * Waits that end when a usage limit resets (a quota used up, a rate limit):
 * orange like an error, and the title says when it is back ("Back in 6d").
 * The codes the daemon will report; none is in READINESS_CODES yet, so a
 * reader keeps them as unknown codes with their `until`.
 */
export const READINESS_LIMIT_WAIT_CODES: ReadonlySet<string> = new Set(["quota_exhausted", "rate_limited"]);

const BACK_IN_IDS = {
  minute: "machine.rack.resetsInMinutes",
  hour: "machine.rack.resetsInHours",
  day: "machine.rack.resetsInDays",
} as const;

/**
 * The light for a readiness that holds the agent (raft-design presence):
 * a limit wait or a block is orange (error), except a Computer offline, which
 * is stone like any offline; a wait that is in progress (the Computer
 * restarting or updating) is yellow (busy).
 */
export function readinessLight(readiness: Readiness): { variant: NonNullable<BadgeProps["variant"]>; presence: Presence } {
  const code = readiness.primary?.code;
  if (code === "computer_offline") return { variant: "muted", presence: "offline" };
  if (readiness.state === "blocked" || (code !== undefined && READINESS_LIMIT_WAIT_CODES.has(code))) return { variant: "warning", presence: "error" };
  return { variant: "busy", presence: "busy" };
}

function runtimeOf(readiness: Readiness, fallbackRuntimeId: string | null | undefined): string {
  const resource = readiness.primary?.resource;
  if (resource?.kind === "runtime") return getRuntimeDisplayName(resource.runtime);
  if ((resource?.kind === "login" || resource?.kind === "login_window") && resource.key.startsWith("shared:")) {
    return getRuntimeDisplayName(resource.key.slice("shared:".length));
  }
  return fallbackRuntimeId ? getRuntimeDisplayName(fallbackRuntimeId) : "";
}

export function formatReadiness(
  formatMessage: IntlShape["formatMessage"],
  readiness: Readiness,
  /** The agent's own runtime, for a reason on its own login. */
  runtimeId?: string | null,
  /** Said of an agent (its chip: "Computer restarting"), not of the Computer itself ("Restarting…"). */
  onAgent = false,
  nowMs: number = Date.now(),
): ReadinessCopy {
  const primary = readiness.primary;
  // A viewer who may not see the reason still reads who can fix it and how: by name ("Olive can sign in."),
  // or, with no name (a guest), by role ("The computer's owner can fix it.").
  const who = readiness.state === "blocked" ? readinessWhoOf(formatMessage, readiness) : null;
  const named = who ? formatMessage({ id: "readiness.sentence" }, { text: who }) : null;
  if (primary && READINESS_LIMIT_WAIT_CODES.has(primary.code)) {
    const reset = rackReset(primary.until ? new Date(primary.until).toISOString() : null, nowMs);
    return {
      title: reset ? formatMessage({ id: BACK_IN_IDS[reset.unit] }, { count: reset.count }) : formatMessage({ id: "readiness.generic.title" }),
      scope: null,
      detail: formatMessage({ id: "readiness.generic.detail" }),
      actor: null,
      link: null,
    };
  }
  if (!primary || !isReadinessCode(primary.code)) {
    return {
      title: formatMessage({ id: "readiness.generic.title" }),
      scope: null,
      detail: formatMessage({ id: "readiness.generic.detail" }),
      actor: named,
      link: null,
    };
  }
  const runtime = runtimeOf(readiness, runtimeId);
  const scope = readiness.scope === "computer"
    ? formatMessage({ id: "readiness.scope.computer" })
    : readiness.scope === "agent"
      ? formatMessage({ id: "readiness.scope.agent" })
      : readiness.scope === "server" ? formatMessage({ id: "readiness.scope.server" }) : null;
  const actor = readiness.actor === "computer_owner"
    ? formatMessage({ id: "readiness.actor.computerOwner" })
    : readiness.actor === "agent_owner"
      ? formatMessage({ id: "readiness.actor.agentOwner" })
      : readiness.actor === "server_admin" ? formatMessage({ id: "readiness.actor.serverAdmin" }) : null;
  switch (primary.code) {
    case "verification_required":
      return {
        title: formatMessage({ id: "readiness.verification_required.title" }),
        scope,
        detail: formatMessage({ id: "readiness.verification_required.detail" }, { runtime }),
        actor,
        link: { href: ANTHROPIC_VERIFICATION_PORTAL_URL, text: formatMessage({ id: "readiness.verification_required.link" }) },
      };
    case "computer_offline":
      return { title: formatMessage({ id: "readiness.computer_offline.title" }), scope, detail: formatMessage({ id: "readiness.computer_offline.detail" }), actor, link: null };
    case "computer_reconnecting":
      return { title: formatMessage({ id: "readiness.computer_reconnecting.title" }), scope, detail: formatMessage({ id: "readiness.computer_reconnecting.detail" }), actor: null, link: null };
    case "computer_restarting":
      return { title: formatMessage({ id: onAgent ? "readiness.computer_restarting.agentTitle" : "readiness.computer_restarting.title" }), scope, detail: formatMessage({ id: "readiness.computer_restarting.detail" }), actor: null, link: null };
    case "computer_updating":
      return { title: formatMessage({ id: onAgent ? "readiness.computer_updating.agentTitle" : "readiness.computer_updating.title" }), scope, detail: formatMessage({ id: "readiness.computer_updating.detail" }), actor: null, link: null };
    case "computer_too_old": {
      const desktop = primary.params?.managedByDesktop === true;
      return {
        title: formatMessage({ id: "readiness.computer_too_old.title" }),
        scope,
        detail: formatMessage({ id: desktop ? "readiness.computer_too_old.desktopDetail" : "readiness.computer_too_old.detail" }),
        actor,
        link: null,
      };
    }
    case "runtime_missing":
      return {
        title: formatMessage({ id: "readiness.runtime_missing.title" }, { runtime }),
        scope,
        detail: formatMessage({ id: "readiness.runtime_missing.detail" }, { runtime }),
        actor,
        link: null,
      };
  }
}

/** The title under its scope ("This Computer's problem: Needs account verification"), joined in the catalog. */
export function readinessHeading(formatMessage: IntlShape["formatMessage"], copy: ReadinessCopy): string {
  return copy.scope ? formatMessage({ id: "readiness.scoped" }, { scope: copy.scope, text: copy.title }) : copy.title;
}

/** What happened, then who fixes it, joined in the catalog. */
export function readinessBody(formatMessage: IntlShape["formatMessage"], copy: ReadinessCopy): string {
  return copy.actor ? formatMessage({ id: "readiness.detailWithActor" }, { detail: copy.detail, actor: copy.actor }) : copy.detail;
}

/** A runtime's readiness on a Computer, as the machine list sent it (trimmed for the viewer); null when none. */
export function useMachineRuntimeReadiness(machineId: string, runtimeId: string): Readiness | null {
  return useMachineStore((state) => state.machines.find((machine) => machine.id === machineId)?.readiness?.runtimes?.[runtimeId] ?? null);
}

const WHO_IDS = {
  sign_in: "readiness.can.sign_in",
  verify_account: "readiness.can.verify_account",
  update_computer: "readiness.can.update_computer",
  fix: "readiness.can.fix",
} as const satisfies Record<ReadinessAction, string>;

const OWNER_CAN_IDS = {
  sign_in: "readiness.ownerCan.sign_in",
  verify_account: "readiness.ownerCan.verify_account",
  update_computer: "readiness.ownerCan.update_computer",
  fix: "readiness.ownerCan.fix",
} as const satisfies Record<ReadinessAction, string>;

const DO_IDS = {
  sign_in: "readiness.do.sign_in",
  verify_account: "readiness.do.verify_account",
  update_computer: "readiness.do.update_computer",
  fix: "readiness.do.fix",
} as const satisfies Record<ReadinessAction, string>;

function knownAction(action: string | undefined): ReadinessAction {
  return action && action in WHO_IDS ? action as ReadinessAction : "fix";
}

/** "Olive can sign in" / "Olive can update this computer" / "Olive can fix it": who acts and how, never why. */
export function readinessWho(formatMessage: IntlShape["formatMessage"], name: string, action: string | undefined): string {
  return formatMessage({ id: WHO_IDS[knownAction(action)] }, { name });
}

/**
 * Who acts and how: by name when the server sent one ("Olive can fix it"),
 * else by role ("The computer's owner can fix it"; a guest never gets the
 * name); null with neither.
 */
export function readinessWhoOf(
  formatMessage: IntlShape["formatMessage"],
  of: { actor?: ReadinessActor | null; actorName?: string; action?: string },
): string | null {
  if (of.actorName) return readinessWho(formatMessage, of.actorName, of.action);
  if (!of.actor) return null;
  return formatMessage({ id: OWNER_CAN_IDS[knownAction(of.action)] }, { actor: of.actor });
}

/** The button for whoever may act on an item: "Sign in", "Update", … ("Open" when nothing closer). */
export function readinessDoLabel(formatMessage: IntlShape["formatMessage"], action: string | undefined): string {
  return formatMessage({ id: DO_IDS[knownAction(action)] });
}

/**
 * One "needs attention" item in words: its title ("Claude Code: Account
 * needs verification", "Update available"; "Needs attention" for a viewer
 * who may not see the reason, or a code this build does not know) and who
 * acts (by name when the server named them, else by role).
 */
export function formatAttentionItem(
  formatMessage: IntlShape["formatMessage"],
  item: ReadinessAttentionItem,
): { title: string; who: string | null } {
  const who = readinessWhoOf(formatMessage, item);
  const code = item.code;
  if (code === "computer_update_available") return { title: formatMessage({ id: "readiness.attention.updateAvailable" }), who };
  if (code === "computer_update_required") return { title: formatMessage({ id: "readiness.attention.updateRequired" }), who };
  if (!code || !item.resource || !isReadinessCode(code)) return { title: formatMessage({ id: "readiness.attention.item" }), who };
  const readiness: Readiness = {
    state: "blocked",
    primary: { resource: item.resource, code, behaviour: "blocked", since: 0 },
    scope: null,
    actor: item.actor,
    also: [],
  };
  const title = formatReadiness(formatMessage, readiness).title;
  const resource = item.resource;
  const onLogin = (resource.kind === "login" || resource.kind === "login_window") && resource.key.startsWith("shared:");
  return {
    title: onLogin ? formatMessage({ id: "readiness.attention.onRuntime" }, { runtime: runtimeOf(readiness, null), title }) : title,
    who,
  };
}

/** Each item of a Computer's summary as one line: "<title> · <who>". */
export function attentionItemLines(formatMessage: IntlShape["formatMessage"], attention: ReadinessAttention | null | undefined): string[] {
  return (attention?.items ?? []).map((item) => {
    const { title, who } = formatAttentionItem(formatMessage, item);
    return who ? formatMessage({ id: "readiness.attention.itemWithWho" }, { title, who }) : title;
  });
}

const WAIT_BACK_IN_IDS = {
  minute: "readiness.attention.backInMinutes",
  hour: "readiness.attention.backInHours",
  day: "readiness.attention.backInDays",
} as const;

/** "back in 6d" for the earliest end of a wait; null when unknown or past. */
export function formatWaitBackIn(formatMessage: IntlShape["formatMessage"], untilMs: number | undefined, nowMs: number): string | null {
  const reset = rackReset(untilMs === undefined ? null : new Date(untilMs).toISOString(), nowMs);
  return reset ? formatMessage({ id: WAIT_BACK_IN_IDS[reset.unit] }, { count: reset.count }) : null;
}
