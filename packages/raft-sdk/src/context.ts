import { z } from "zod";
import type { AgentApiClient } from "@botiverse/raft-shared/src/agentApiClient";

/** The bound External Agent. */
export interface RaftContextAgent {
  id: string;
  name: string;
  displayName: string | null;
  description: string | null;
  runtime: string;
  external: boolean;
  /** Current findings-tool availability; false when omitted by the Server. */
  raftbenchReader: boolean;
  /**
   * Set when this agent is someone's personal assistant (RFC 074): the
   * `routes.assistant.*` reads exist for it. Null otherwise, and on Servers
   * that predate the field. Says nothing about whether the feature is on.
   */
  assistantOf: RaftAssistantOf | null;
}

/** Whose personal assistant this agent is (RFC 075). */
export interface RaftAssistantOf {
  userId: string;
  /** The owner's handle, without `@`; null on older Servers. */
  name: string | null;
  /** The owner's display name; null when unset or on older Servers. */
  displayName: string | null;
  /**
   * Raft runs this assistant's checks and morning brief (RFC 077 step 2): a
   * runtime turns its own off while true. False on older Servers.
   */
  raftCheck: boolean;
  /** The owner's IANA time zone, e.g. `Asia/Shanghai`; null when unknown or on older Servers. */
  timezone: string | null;
  /**
   * The language to talk to the owner in, as a language tag (`zh-CN`, `en`):
   * the owner's translation language, else their UI language. Null when they
   * set neither, or on older Servers; then follow the owner's own messages.
   */
  language: string | null;
  /** The DM with the owner (`dm:@owner~human`) to send to; null until it exists, or on older Servers. */
  dmTarget: string | null;
}

/** The single Server the credential is bound to. */
export interface RaftContextServer {
  id: string;
  slug: string;
  name: string;
}

/**
 * Server rollout flags that change how the agent should work. They match what
 * a daemon-managed agent's prompt is built from. Both booleans are false, and
 * `enabledApps` is empty, on Servers that predate the field.
 */
export interface RaftContextFeatures {
  /** Reminders moved to the Reminder app; `raft reminder schedule` is refused. */
  reminderApp: boolean;
  /** Secrets go through the Vault app. */
  vaultApp: boolean;
  /**
   * Ids of Raft's first-party apps switched on for this Server, such as
   * `artifacts`. Not the Reminder or Vault app (installed apps; see the
   * booleans above). Treat an id you don't know as nothing to do.
   */
  enabledApps: string[];
}

export interface RaftContextData {
  agent: RaftContextAgent;
  server: RaftContextServer;
  /** Capabilities granted to this credential, for example `send` or `read`. */
  capabilities: string[];
  /** The rendered operating guide for External Agents; null for daemon-managed agents. */
  guide: string | null;
  features: RaftContextFeatures;
}

export interface RaftContextError {
  code: "TRANSPORT_ERROR" | "HTTP_ERROR" | "INVALID_RESPONSE";
  /** Safe SDK text; raw transport errors and response bodies are never included. */
  message: string;
}

export type RaftContextResult =
  | { ok: true; status: number; data: RaftContextData }
  | { ok: false; status?: number; error: RaftContextError };

// The shared contract validates the wire shape and allows extra keys; this
// projection exports only documented fields.
const projection = z.object({
  agent: z.object({
    id: z.string(),
    name: z.string(),
    displayName: z.string().nullable(),
    description: z.string().nullable(),
    runtime: z.string(),
    external: z.boolean(),
    raftbenchReader: z.literal(true).optional(),
    assistantOf: z.object({
      userId: z.string(),
      name: z.string().nullable().optional(),
      displayName: z.string().nullable().optional(),
      raftCheck: z.boolean().optional(),
      timezone: z.string().nullable().optional(),
      language: z.string().nullable().optional(),
      dmTarget: z.string().nullable().optional(),
    }).nullable().optional(),
  }),
  server: z.object({ id: z.string(), slug: z.string(), name: z.string() }),
  credential: z.object({ capabilities: z.array(z.string()) }),
  prompt: z.object({ text: z.string() }).nullable(),
  features: z.object({ reminderApp: z.boolean(), vaultApp: z.boolean(), enabledApps: z.array(z.string()).optional() }).optional(),
});

function failure(code: RaftContextError["code"], status?: number): RaftContextResult {
  const messages: Record<RaftContextError["code"], string> = {
    TRANSPORT_ERROR: "Agent context transport failed.",
    HTTP_ERROR: "Agent context returned an HTTP error.",
    INVALID_RESPONSE: "Agent context response did not match the SDK contract.",
  };
  return { ok: false, ...(status === undefined ? {} : { status }), error: { code, message: messages[code] } };
}

/** Internal adapter for `client.agent.context()`. Read-only; safe to retry. */
export async function getRaftContext(client: Pick<AgentApiClient, "agent">): Promise<RaftContextResult> {
  const result = await client.agent.context();
  if (!result.ok) {
    return failure(result.error.kind === "transport" ? "TRANSPORT_ERROR"
      : result.error.kind === "http" ? "HTTP_ERROR" : "INVALID_RESPONSE", result.status);
  }
  const parsed = projection.safeParse(result.data);
  if (!parsed.success) return failure("INVALID_RESPONSE", result.status);
  const { agent, server, credential, prompt, features } = parsed.data;
  return {
    ok: true,
    status: result.status,
    data: {
      agent: {
        id: agent.id,
        name: agent.name,
        displayName: agent.displayName,
        description: agent.description,
        runtime: agent.runtime,
        external: agent.external,
        raftbenchReader: agent.raftbenchReader === true,
        assistantOf: agent.assistantOf
          ? {
            userId: agent.assistantOf.userId,
            name: agent.assistantOf.name ?? null,
            displayName: agent.assistantOf.displayName ?? null,
            raftCheck: agent.assistantOf.raftCheck === true,
            timezone: agent.assistantOf.timezone ?? null,
            language: agent.assistantOf.language ?? null,
            dmTarget: agent.assistantOf.dmTarget ?? null,
          }
          : null,
      },
      server: { ...server },
      capabilities: [...credential.capabilities],
      guide: prompt?.text ?? null,
      features: {
        reminderApp: features?.reminderApp === true,
        vaultApp: features?.vaultApp === true,
        enabledApps: [...(features?.enabledApps ?? [])],
      },
    },
  };
}
