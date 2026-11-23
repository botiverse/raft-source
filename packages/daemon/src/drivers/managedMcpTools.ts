import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import {
  MCP_OUTCOME_UNKNOWN_TEXT,
  flattenManagedMcpPromptText,
  formatManagedMcpPromptName,
  type ManagedMcpCallResult,
  type ManagedMcpRuntimeSnapshot,
  type ManagedMcpRuntimeTool,
} from "@botiverse/raft-shared";
import { managedMcpRefusalGuidance } from "../managedMcpRefusal";
import { fetchWithRunnerCredential } from "../runnerCredentialRenewal";
import {
  confirmRuntimeTurnOrigin,
  type RuntimeTurnOriginReader,
} from "../runtimeTurnOrigin";

const MANAGED_MCP_HTTP_TIMEOUT_MS = 25_000;

class ManagedMcpHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
    readonly connectionRequested?: boolean,
    readonly agentWorded?: boolean,
  ) {
    super(message);
    this.name = "ManagedMcpHttpError";
  }
}
async function requestJson<T>(input: {
  url: URL;
  token: string;
  method?: "GET" | "POST";
  body?: unknown;
  signal?: AbortSignal;
}): Promise<T> {
  const timeout = AbortSignal.timeout(MANAGED_MCP_HTTP_TIMEOUT_MS);
  const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
  // #wg-rbac:#27: the launch's runner key as renewed; a 401
  // agent_credential_expired renews it and sends once more.
  const response = await fetchWithRunnerCredential(input.token, (token) => fetch(input.url, {
    method: input.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "X-Slock-Agent-Active-Capabilities": "mcp",
      ...(input.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
    signal,
  }));
  const payload = await response.json().catch(() => null) as
    | { error?: unknown; code?: unknown; connectionRequested?: unknown; suggestedNextAction?: unknown }
    | T
    | null;
  if (!response.ok) {
    const error = typeof (payload as { error?: unknown } | null)?.error === "string"
      ? (payload as { error: string }).error
      : `HTTP ${response.status}`;
    const code = typeof (payload as { code?: unknown } | null)?.code === "string"
      ? (payload as { code: string }).code
      : null;
    const connectionRequested =
      (payload as { connectionRequested?: unknown } | null)?.connectionRequested === true;
    const agentWorded = typeof (payload as { suggestedNextAction?: unknown } | null)?.suggestedNextAction === "string";
    throw new ManagedMcpHttpError(error, response.status, code, connectionRequested, agentWorded);
  }
  return payload as T;
}

function isRuntimeSnapshot(value: unknown): value is ManagedMcpRuntimeSnapshot {
  return typeof value === "object"
    && value !== null
    && (value as { catalogVersion?: unknown }).catalogVersion === 1
    && Array.isArray((value as { tools?: unknown }).tools);
}

/** A remote tool error's text, capped; a cut is marked so the model doesn't take it as the whole answer. */
export const MANAGED_MCP_ERROR_TEXT_LIMIT = 4_000;

function resultText(result: ManagedMcpCallResult, tool: Pick<ManagedMcpRuntimeTool, "runtimeName">): string {
  const text = result.content
    .filter((block): block is Extract<ManagedMcpCallResult["content"][number], { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  // Same words as raft-sdk: name the tool.
  if (!text) return `${tool.runtimeName} failed`;
  return text.length > MANAGED_MCP_ERROR_TEXT_LIMIT ? `${text.slice(0, MANAGED_MCP_ERROR_TEXT_LIMIT)}…[truncated]` : text;
}

/** The same refusal, with guidance in the message and the code still attached. */
function refusalWithGuidance(error: ManagedMcpHttpError): ManagedMcpHttpError {
  return new ManagedMcpHttpError(
    managedMcpRefusalGuidance({
      message: error.message,
      code: error.code,
      connectionRequested: error.connectionRequested,
      agentWorded: error.agentWorded,
    }),
    error.status,
    error.code,
    error.connectionRequested,
    error.agentWorded,
  );
}

type JsonValueKind = "object" | "array" | "string";

function jsonValueKind(value: unknown): JsonValueKind | null {
  if (typeof value === "string") return "string";
  if (Array.isArray(value)) return "array";
  if (typeof value === "object" && value !== null) return "object";
  return null;
}

function isSchemaObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveLocalSchemaRef(root: Record<string, unknown>, ref: string): unknown {
  if (!ref.startsWith("#/")) return undefined;
  let current: unknown = root;
  for (const token of ref.slice(2).split("/")) {
    if (!isSchemaObject(current)) return undefined;
    current = current[token.replaceAll("~1", "/").replaceAll("~0", "~")];
  }
  return typeof current === "boolean" || isSchemaObject(current) ? current : undefined;
}

/**
 * Whether `schema` may accept a value of `kind`. Errs towards "yes": anything this small check
 * cannot prove (`not`, unresolved `$ref`s, cycles, unconstrained schemas) counts as accepting, so
 * the caller leaves the value alone rather than coercing it through a guess.
 */
function schemaMayAccept(
  schema: unknown,
  kind: JsonValueKind,
  root: Record<string, unknown>,
  refs: ReadonlySet<string> = new Set(),
): boolean {
  if (typeof schema === "boolean") return schema;
  if (!isSchemaObject(schema)) return true;

  if (typeof schema.$ref === "string") {
    if (refs.has(schema.$ref)) return true;
    const resolved = resolveLocalSchemaRef(root, schema.$ref);
    if (resolved === undefined) return true;
    return schemaMayAccept(resolved, kind, root, new Set(refs).add(schema.$ref));
  }
  if (schema.not !== undefined) return true;

  let allowed = true;
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    allowed &&= types.includes(kind);
  }
  if (schema.const !== undefined) allowed &&= jsonValueKind(schema.const) === kind;
  if (Array.isArray(schema.enum)) allowed &&= schema.enum.some((value) => jsonValueKind(value) === kind);
  for (const keyword of ["anyOf", "oneOf"] as const) {
    const branches = schema[keyword];
    if (Array.isArray(branches)) allowed &&= branches.some((branch) => schemaMayAccept(branch, kind, root, refs));
  }
  if (Array.isArray(schema.allOf)) {
    allowed &&= schema.allOf.every((branch) => schemaMayAccept(branch, kind, root, refs));
  }
  return allowed;
}

/**
 * A JSON-encoded object or array where the schema wants one, decoded. Models sometimes send
 * `"{\"page_id\":\"…\"}"` for an object-typed field; Pi's validation coerces scalars but never
 * JSON-parses, so the call would fail. Only a value the schema cannot take as a string, that parses
 * to a kind the schema can take, is replaced; anything else is returned unchanged for validation to
 * judge.
 */
function decodeJsonStringFor(schema: unknown, value: unknown, root: Record<string, unknown>): unknown {
  if (typeof value !== "string" || schemaMayAccept(schema, "string", root)) return value;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return value;
  }
  const kind = jsonValueKind(parsed);
  return (kind === "object" || kind === "array") && schemaMayAccept(schema, kind, root) ? parsed : value;
}

/** `prepareArguments` for a managed MCP tool: repairs JSON-string arguments (whole, or per top-level property). */
function prepareManagedMcpArguments(schema: Record<string, unknown>, args: unknown): unknown {
  const decoded = decodeJsonStringFor(schema, args, schema);
  if (!isSchemaObject(decoded) || !isSchemaObject(schema.properties)) return decoded;
  let prepared: Record<string, unknown> | undefined;
  for (const [name, propertySchema] of Object.entries(schema.properties)) {
    if (!Object.hasOwn(decoded, name)) continue;
    const value = decoded[name];
    const repaired = decodeJsonStringFor(propertySchema, value, schema);
    if (repaired === value) continue;
    prepared ??= { ...decoded };
    prepared[name] = repaired;
  }
  return prepared ?? decoded;
}

function buildTool(input: {
  tool: ManagedMcpRuntimeTool;
  serverUrl: string;
  token: string;
  processInstanceId: string | null | undefined;
  readTurnOrigin: RuntimeTurnOriginReader | undefined;
  /** Re-reads the Agent's live tool snapshot. Used only to recover from a stale-config refusal. */
  refreshSnapshot: () => Promise<ManagedMcpRuntimeSnapshot | null>;
}): ToolDefinition {
  // ⚠️ Mutable on purpose. The tool list is built once per session, so the catalogue versions
  // captured here go stale the moment an operator edits the MCP server or this Agent's assignment.
  // Before this, every later call in the session failed with `managed_mcp_config_stale` and the
  // session had no way back: the only recovery was restarting the Agent.
  let tool = input.tool;
  return {
    name: tool.runtimeName,
    // Names, title and description come from the remote server (or the connector's setup):
    // names quoted on one line so they cannot break out of the text they sit in.
    label: tool.title ? flattenManagedMcpPromptText(tool.title) : `${formatManagedMcpPromptName(tool.serverName)}: ${formatManagedMcpPromptName(tool.toolName)}`,
    description: tool.description || `Call ${formatManagedMcpPromptName(tool.toolName)} on the managed MCP server ${formatManagedMcpPromptName(tool.serverName)}.`,
    promptSnippet: `${tool.runtimeName}: ${tool.description ? flattenManagedMcpPromptText(tool.description) : `Call ${formatManagedMcpPromptName(tool.toolName)} on ${formatManagedMcpPromptName(tool.serverName)}`}`,
    parameters: tool.inputSchema as TSchema,
    // Against the same schema `parameters` validates with, not a later refreshed one. What it returns
    // is unvalidated (it can still be a string): Pi's validation runs next and judges it.
    prepareArguments: (args) => prepareManagedMcpArguments(input.tool.inputSchema, args),
    async execute(_toolCallId, params, signal) {
      // The tools are built once per session, so the origin cannot be baked in: it is read here, at
      // call time, from the getter bound to this session's process (task #21).
      const origin = confirmRuntimeTurnOrigin({
        read: input.readTurnOrigin,
        captured: input.readTurnOrigin?.() ?? null,
        expectedProcessInstanceId: input.processInstanceId,
      });
      const call = (current: ManagedMcpRuntimeTool) => requestJson<ManagedMcpCallResult>({
        url: new URL("/internal/agent-api/mcp/call", input.serverUrl),
        token: input.token,
        method: "POST",
        body: {
          mcpServerId: current.mcpServerId,
          toolName: current.toolName,
          arguments: params as Record<string, unknown>,
          expectedConfigVersion: current.configVersion,
          expectedAssignmentVersion: current.assignmentVersion,
          ...(origin ? { origin } : {}),
        },
        signal,
      });
      // An HTTP answer with Raft's JSON `code` is Raft's own (its agent-facing
      // text). A transport failure mid-call, or a 5xx from something in between
      // (no Raft code), has an unknown outcome: same words as raft-sdk.
      const isRaftAnswer = (error: unknown): error is ManagedMcpHttpError =>
        error instanceof ManagedMcpHttpError && !(error.status >= 500 && error.code === null);
      const outcomeUnknown = (error: unknown): unknown => (signal?.aborted ? error : new Error(MCP_OUTCOME_UNKNOWN_TEXT));

      let result: ManagedMcpCallResult;
      try {
        result = await call(tool);
      } catch (error) {
        if (!isRaftAnswer(error)) throw outcomeUnknown(error);
        // A stale catalogue is the one refusal the runtime can fix by itself: re-read the snapshot,
        // adopt the current versions and retry ONCE. Anything else is for a human.
        // ⚠️ Rethrow the TYPED error, not a bare `Error`. Decorating the message must not strip the
        // machine-readable code: callers (and tests) that branch on `.code` would silently fall
        // through to a generic path.
        if (error.code !== "managed_mcp_config_stale") throw refusalWithGuidance(error);
        const snapshot = await input.refreshSnapshot();
        const refreshed = snapshot?.tools.find(
          (candidate) => candidate.mcpServerId === tool.mcpServerId && candidate.toolName === tool.toolName,
        );
        if (!refreshed) {
          throw new Error(
            `${error.message.replace(/[.\s]+$/, "")}. This tool is no longer available to this Agent after that change, so it cannot be retried.`,
          );
        }
        tool = refreshed;
        // Deliberately not a loop: a second stale answer means something is changing faster than a
        // turn can follow, and retrying again would just hide it.
        result = await call(refreshed).catch((retryError: unknown) => {
          if (isRaftAnswer(retryError)) throw refusalWithGuidance(retryError);
          throw outcomeUnknown(retryError);
        });
      }
      if (result.isError) throw new Error(resultText(result, tool));
      return {
        content: result.content.map((block) => block.type === "text"
          ? { type: "text" as const, text: block.text }
          : { type: "image" as const, data: block.data, mimeType: block.mimeType }),
        details: {
          managedMcp: true,
          mcpServerId: tool.mcpServerId,
          toolName: tool.toolName,
          ...(result.structuredContent ? { structuredContent: result.structuredContent } : {}),
        },
      };
    },
  };
}

export async function createManagedMcpPiTools(input: {
  serverUrl: string;
  agentCredentialKey: string | null | undefined;
  processInstanceId?: string | null;
  readTurnOrigin?: RuntimeTurnOriginReader;
  onWarning?: (message: string) => void;
}): Promise<ToolDefinition[]> {
  if (!input.agentCredentialKey) return [];
  try {
    const snapshot = await requestJson<ManagedMcpRuntimeSnapshot>({
      url: new URL("/internal/agent-api/mcp/tools", input.serverUrl),
      token: input.agentCredentialKey,
    });
    if (!isRuntimeSnapshot(snapshot)) throw new Error("Managed MCP snapshot contract is invalid");
    return snapshot.tools.map((tool) => buildTool({
      tool,
      serverUrl: input.serverUrl,
      token: input.agentCredentialKey!,
      processInstanceId: input.processInstanceId,
      readTurnOrigin: input.readTurnOrigin,
      refreshSnapshot: async () => {
        try {
          const refreshed = await requestJson<ManagedMcpRuntimeSnapshot>({
            url: new URL("/internal/agent-api/mcp/tools", input.serverUrl),
            token: input.agentCredentialKey!,
          });
          return isRuntimeSnapshot(refreshed) ? refreshed : null;
        } catch {
          // Recovery is best-effort: a failed refresh leaves the original refusal to be reported,
          // rather than replacing it with a second, less informative error.
          return null;
        }
      },
    }));
  } catch (error) {
    const detail = error instanceof ManagedMcpHttpError
      ? `${error.code ?? "managed_mcp_http_error"} (${error.status})`
      : error instanceof Error ? error.message.slice(0, 200) : "unknown error";
    input.onWarning?.(`Managed MCP tools unavailable for this session: ${detail}`);
    return [];
  }
}
