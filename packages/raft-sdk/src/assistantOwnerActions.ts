import type { AgentApiClient } from "@botiverse/raft-shared/src/agentApiClient";
import type { AgentApiAssistantOwnerAction } from "@botiverse/raft-shared/src/agentApiContract";

/**
 * One action a personal assistant may take as its owner, as its context lists
 * it (`assistantOf.ownerActions`): the tool, its parameters, and the owner's own
 * web route it calls. Build tools from `description` and `params` verbatim.
 */
export type RaftOwnerAction = AgentApiAssistantOwnerAction;

/**
 * Raft's own text; pass it to the model as is. A direct action: what changed
 * (`done`) and how to undo it. A read: `text`, the owner's state as Raft
 * wrote it (the route's own JSON never comes back). A confirm action: `state`
 * `pending_owner_confirm` and `text` (nothing ran; a card waits for the owner),
 * with the card and when it expires.
 */
export interface RaftOwnerActionReport {
  done?: string;
  /** A `position` argument may be `{ after: "#x" }`. */
  undo?: { tool: string; args: Record<string, string | boolean | { after: string }>; text: string } | null;
  state?: "pending_owner_confirm" | "owner_declined" | string;
  text?: string;
  cardMessageId?: string;
  expiresAt?: string;
}

export type RaftOwnerActionRunResult =
  | { ok: true; status: number; assistant: RaftOwnerActionReport | null; data: Record<string, unknown>; text: string }
  | {
    ok: false;
    status?: number;
    /** `UNKNOWN_TOOL`, `INVALID_ARGS`, `NOT_FOUND` (a ref the owner can't see), `HTTP_ERROR` (Raft refused; `errorCode` says why) or `TRANSPORT_ERROR`. */
    code: "UNKNOWN_TOOL" | "INVALID_ARGS" | "NOT_FOUND" | "HTTP_ERROR" | "TRANSPORT_ERROR";
    errorCode?: string;
    text: string;
  };

/** The tiers this SDK knows; an entry with any other tier is left out of `actions` (Raft enforces tiers itself). */
export const RAFT_OWNER_ACTION_TIERS = ["direct", "confirm", "read"] as const;

export interface RaftOwnerActionList {
  /** The owner actions this assistant may take (empty for any other agent, and on older Servers). */
  actions: RaftOwnerAction[];
  /**
   * Entries left out because this SDK doesn't know their `tier` (a newer
   * Server added one). Log them where you build tools from `actions`; `run`
   * answers them as not available here yet.
   */
  skipped: Array<{ tool: string; tier: string }>;
}

export interface RaftAssistantOwnerActions {
  /** The owner actions this assistant may take, and those left out for an unknown tier. */
  list(): Promise<RaftOwnerActionList>;
  /**
   * Run one: refs (`#design`) are resolved as the owner sees them, then the
   * owner's route is called with this agent's credential. On success `text` is
   * Raft's done line and undo line.
   */
  run(tool: string, args: Record<string, unknown>): Promise<RaftOwnerActionRunResult>;
}

interface Deps {
  api: Pick<AgentApiClient, "agent" | "request">;
  serverUrl: string;
  fetch: typeof fetch;
  headers: Record<string, string>;
  authorization: string;
}

type OwnerContext = { owner: string; serverId: string } & RaftOwnerActionList;

/** A `position` argument: `"top"`, `"bottom"` or `{ after: "#x" | "dm:@x" }`. */
function readPosition(value: unknown): "top" | "bottom" | { after: string } | null {
  if (value === "top" || value === "bottom") return value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const after = (value as { after?: unknown }).after;
    if (typeof after === "string" && after.trim() && Object.keys(value).length === 1) return { after: after.trim() };
  }
  return null;
}

function knownTier(tier: unknown): boolean {
  return typeof tier === "string" && (RAFT_OWNER_ACTION_TIERS as readonly string[]).includes(tier);
}

function fail(code: Exclude<RaftOwnerActionRunResult, { ok: true }>["code"], text: string, extra: { status?: number; errorCode?: string } = {}): RaftOwnerActionRunResult {
  return { ok: false, code, text, ...extra };
}

export function createRaftAssistantOwnerActions(deps: Deps): RaftAssistantOwnerActions {
  const readContext = async (): Promise<OwnerContext | null> => {
    const result = await deps.api.agent.context();
    if (!result.ok) return null;
    const data = result.data as { agent?: { assistantOf?: { name?: string | null; displayName?: string | null; ownerActions?: RaftOwnerAction[] } | null }; server?: { id?: string } };
    const of = data.agent?.assistantOf;
    if (!of || !data.server?.id) return { owner: "your owner", serverId: data.server?.id ?? "", actions: [], skipped: [] };
    const entries = Array.isArray(of.ownerActions) ? of.ownerActions : [];
    return {
      owner: of.displayName || of.name || "your owner",
      serverId: data.server.id,
      actions: entries.filter((entry) => knownTier(entry.tier)),
      skipped: entries.filter((entry) => !knownTier(entry.tier)).map((entry) => ({ tool: String(entry.tool), tier: String(entry.tier) })),
    };
  };

  /**
   * A `#channel` (or, where `dm` is allowed, a `dm:@peer`: the owner's existing
   * DM with them) the owner can see, by id; the not-found text otherwise.
   */
  const resolveConversation = async (ref: string, owner: string, allowDm: boolean): Promise<{ id: string } | { error: RaftOwnerActionRunResult }> => {
    const trimmed = ref.trim();
    const isDm = /^dm:@[^:\s]+$/.test(trimmed);
    if (isDm && !allowDm) return { error: fail("INVALID_ARGS", `"${ref}" is a DM; this takes a channel as #name.`) };
    if (!isDm && (!trimmed.startsWith("#") || trimmed.includes(":") || trimmed.length < 2)) {
      if (trimmed.includes(":") && trimmed.startsWith("#")) return { error: fail("INVALID_ARGS", `Only channels (#name)${allowDm ? " and DMs (dm:@name)" : ""} for now; ${owner} can do this for a thread themselves.`) };
      return { error: fail("INVALID_ARGS", `"${ref}" is not a ${allowDm ? "channel or DM. Give a channel as #name or a DM as dm:@name." : "channel. Give a channel as #name."}`) };
    }
    const notFound = isDm ? `No DM with ${trimmed.slice(3)} that ${owner} can see.` : `No channel named ${trimmed} that ${owner} can see.`;
    const result = await deps.api.request("assistantOwnerResolve", { query: { name: trimmed } });
    if (!result.ok) {
      if (result.status === 404) return { error: fail("NOT_FOUND", notFound, { status: 404 }) };
      if (result.status === 409) return { error: fail("INVALID_ARGS", `${trimmed} names both a person and an agent. Add ~human or ~agent.`, { status: 409 }) };
      return { error: fail(result.error.kind === "transport" ? "TRANSPORT_ERROR" : "HTTP_ERROR", `Couldn't look up ${trimmed}: ${result.error.message}`, { status: result.status }) };
    }
    const data = result.data as { id: string; type: string };
    if (data.type !== (isDm ? "dm" : "channel")) return { error: fail("NOT_FOUND", notFound, { status: 404 }) };
    return { id: data.id };
  };

  /** An agent (`@name`) the owner can see, by id; the not-found text otherwise. */
  const resolveAgent = async (ref: string, owner: string): Promise<{ id: string } | { error: RaftOwnerActionRunResult }> => {
    const trimmed = ref.trim();
    if (!/^@[^\s:#]+$/.test(trimmed)) return { error: fail("INVALID_ARGS", `"${ref}" is not an agent. Give an agent as @name.`) };
    const notFound = `No agent named ${trimmed} that ${owner} can see.`;
    const result = await deps.api.request("assistantOwnerResolve", { query: { name: trimmed.includes("~") ? trimmed : `${trimmed}~agent` } });
    if (!result.ok) {
      if (result.status === 404) return { error: fail("NOT_FOUND", notFound, { status: 404 }) };
      return { error: fail(result.error.kind === "transport" ? "TRANSPORT_ERROR" : "HTTP_ERROR", `Couldn't look up ${trimmed}: ${result.error.message}`, { status: result.status }) };
    }
    const data = result.data as { id: string; type: string };
    if (data.type !== "agent") return { error: fail("NOT_FOUND", notFound, { status: 404 }) };
    return { id: data.id };
  };

  return {
    async list() {
      const context = await readContext();
      return { actions: context?.actions ?? [], skipped: context?.skipped ?? [] };
    },
    async run(tool, args) {
      const context = await readContext();
      if (!context) return fail("TRANSPORT_ERROR", "Couldn't read this agent's context from Raft. Try again.");
      const action = context.actions.find((entry) => entry.tool === tool);
      // A tool whose tier this SDK doesn't know is listed by Raft but not offered here.
      if (!action && context.skipped.some((entry) => entry.tool === tool)) {
        return fail("UNKNOWN_TOOL", `${tool} isn't available here yet. Tell ${context.owner} they can do it themselves in Raft.`);
      }
      if (!action) {
        const names = context.actions.map((entry) => entry.tool).join(", ") || "none";
        return fail("UNKNOWN_TOOL", `No owner action named ${tool}. Yours: ${names}.`);
      }
      const values: Record<string, unknown> = {};
      for (const param of action.params) {
        const value = args[param.name];
        // A read's option (its filter) may be left out.
        if (value === undefined && (param as { optional?: unknown }).optional === true) continue;
        if (value === undefined) return fail("INVALID_ARGS", `${tool} needs ${param.name}: ${param.description}`);
        if (param.kind === "boolean" && typeof value !== "boolean") return fail("INVALID_ARGS", `${param.name} must be true or false.`);
        if (param.kind === "enum" && (typeof value !== "string" || !(param.values ?? []).includes(value))) {
          return fail("INVALID_ARGS", `${param.name} must be one of ${(param.values ?? []).join(", ")}.`);
        }
        if ((param.kind === "channel" || param.kind === "channel_or_server") && typeof value !== "string") {
          return fail("INVALID_ARGS", `${param.name} must be a channel as #name${param.kind === "channel_or_server" ? ", or \"server\"" : ""}.`);
        }
        if (param.kind === "conversation" && typeof value !== "string") {
          return fail("INVALID_ARGS", `${param.name} must be a channel as #name or a DM as dm:@name.`);
        }
        if ((param.kind === "agent" || param.kind === "text") && (typeof value !== "string" || !value.trim())) {
          return fail("INVALID_ARGS", `${param.name} must be ${param.kind === "agent" ? "an agent as @name" : "text"}.`);
        }
        if (param.kind === "conversation_list" && (!Array.isArray(value) || value.length > 200 || !value.every((item) => typeof item === "string" && item.trim()))) {
          return fail("INVALID_ARGS", `${param.name} must be a list of conversations, each a channel as #name or a DM as dm:@name.`);
        }
        if (param.kind === "position" && !readPosition(value)) {
          return fail("INVALID_ARGS", `${param.name} must be "top", "bottom" or { after: "#name" }.`);
        }
        values[param.name] = value;
      }
      let path = action.path;
      const body: Record<string, unknown> = {};
      const query = new URLSearchParams();
      for (const map of action.mapping) {
        const value = values[map.param];
        if (map.into === "query" && map.field) {
          // A read's option, as given; left out when not given.
          if (value !== undefined) query.set(map.field, String(value));
          continue;
        }
        if (map.into === "level_scope") {
          if (value === "server") {
            body.scope = "server";
            body.id = context.serverId;
          } else {
            const channel = await resolveConversation(String(value), context.owner, false);
            if ("error" in channel) return channel.error;
            body.scope = "channel";
            body.id = channel.id;
          }
        } else if (map.into === "path" && map.field && action.params.find((param) => param.name === map.param)?.kind === "agent") {
          const agent = await resolveAgent(String(value), context.owner);
          if ("error" in agent) return agent.error;
          path = path.replace(`:${map.field}`, encodeURIComponent(agent.id));
        } else if (map.into === "path" && map.field) {
          const kind = action.params.find((param) => param.name === map.param)?.kind;
          const channel = await resolveConversation(String(value), context.owner, kind === "conversation");
          if ("error" in channel) return channel.error;
          path = path.replace(`:${map.field}`, encodeURIComponent(channel.id));
        } else if (map.into === "body" && map.field) {
          body[map.field] = value;
        } else if (map.into === "body_ref" && map.field) {
          // A conversation the owner can see, by id; Raft computes the route's own body from it.
          const kind = action.params.find((param) => param.name === map.param)?.kind;
          const conversation = await resolveConversation(String(value), context.owner, kind === "conversation");
          if ("error" in conversation) return conversation.error;
          body[map.field] = conversation.id;
        } else if (map.into === "body_ref_list" && map.field) {
          // Each conversation the owner can see, by id, in the order given (#proj-assistant:#28).
          const ids: string[] = [];
          for (const ref of value as string[]) {
            const conversation = await resolveConversation(ref, context.owner, true);
            if ("error" in conversation) return conversation.error;
            ids.push(conversation.id);
          }
          body[map.field] = ids;
        } else if (map.into === "body_position" && map.field) {
          const position = readPosition(value)!;
          if (typeof position === "string") {
            body[map.field] = position;
          } else {
            const after = await resolveConversation(position.after, context.owner, true);
            if ("error" in after) return after.error;
            body[map.field] = { after: after.id };
          }
        } else {
          return fail("INVALID_ARGS", `${tool} isn't available here yet. Tell ${context.owner} they can do it themselves in Raft.`);
        }
      }
      // A route of this server (`/api/servers/:id/...`) names it in the path; the assistant's own server.
      if (path.startsWith("/api/servers/:id/")) path = path.replace(":id", encodeURIComponent(context.serverId));
      if (/\/:[^/]+/.test(path)) {
        return fail("INVALID_ARGS", `${tool} isn't available here yet. Tell ${context.owner} they can do it themselves in Raft.`);
      }
      let response: Response;
      try {
        const search = query.toString();
        response = await deps.fetch(`${deps.serverUrl}${path}${search ? `?${search}` : ""}`, {
          method: action.method,
          headers: { ...deps.headers, authorization: deps.authorization, "content-type": "application/json", "x-server-id": context.serverId },
          ...(action.method === "GET" ? {} : { body: JSON.stringify(body) }),
          cache: "no-store",
          redirect: "error",
        });
      } catch {
        return fail("TRANSPORT_ERROR", `Couldn't reach Raft to run ${tool}. Try again.`);
      }
      let payload: Record<string, unknown> = {};
      try {
        const parsed: unknown = await response.json();
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) payload = parsed as Record<string, unknown>;
      } catch { /* a body that is not JSON reads as empty */ }
      if (!response.ok) {
        const errorCode = typeof payload.code === "string" ? payload.code : undefined;
        const message = typeof payload.error === "string" ? payload.error : `Raft refused ${tool} (HTTP ${response.status}).`;
        const next = typeof payload.suggestedNextAction === "string" ? ` ${payload.suggestedNextAction}` : "";
        return fail("HTTP_ERROR", `${message}${next}`, { status: response.status, ...(errorCode ? { errorCode } : {}) });
      }
      const { assistant: raw, ...data } = payload;
      const assistant = raw && typeof raw === "object" ? raw as RaftOwnerActionReport : null;
      // A confirm action answers 202 with its own text (nothing ran yet), a read with Raft's text of what it read;
      // a direct one with done and undo.
      const text = assistant
        ? (typeof assistant.text === "string" ? assistant.text : [assistant.done, assistant.undo?.text].filter(Boolean).join(" "))
        : `${tool} done.`;
      return { ok: true, status: response.status, assistant, data, text };
    },
  };
}
