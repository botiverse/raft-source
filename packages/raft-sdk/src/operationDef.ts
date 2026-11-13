// What an operation of the manifest declares (operations.ts derives the rest:
// its tool schema, side effect, idempotency and capability). A leaf module, so
// a first-party app's operations (apps/<id>.ts) can be written next to the
// app without importing the manifest.
import type { z } from "zod";
import type { AgentApiRouteKey } from "@botiverse/raft-shared/src/agentApiContract";
import type { RaftConsumption } from "./operations";

export interface OperationDef {
  name: string;
  /** Override only to keep a name stable across a rename; otherwise derived from `name`. */
  toolName?: string;
  description: string;
  schema: z.ZodType;
  /** Fields the runtime accepts but the tool schema does not advertise (code-only knobs). */
  hiddenFields?: readonly string[];
  /** Union-typed top-level fields → the one type the tool schema advertises (the runtime accepts that spelling the same). */
  unionAs?: Readonly<Record<string, "string" | "integer" | "number" | "boolean">>;
  /** Tool-schema descriptions for top-level fields whose zod schema (shared with the Server) carries none. */
  fieldDescriptions?: Readonly<Record<string, string>>;
  /** The Agent API routes the operation calls. */
  routes: readonly AgentApiRouteKey[];
  /** Semantics of an operation that calls no route. */
  local?: { sideEffect: "read" | "write"; idempotency: "natural" | "none" };
  /** The argument carrying the idempotency key, when the routes are keyed. */
  idempotencyArg?: string;
  mayInterrupt?: boolean;
  consumes: { model: RaftConsumption[]; code: RaftConsumption[] | "refused" };
  output: { mayBeLarge: boolean; boundBy: string[] };
  deprecated?: boolean;
}

/** Consumes nothing, from the model or from code. */
export const NO_CONSUMPTION = { model: [], code: [] } satisfies OperationDef["consumes"];
/** A result that is never large. */
export const SMALL_OUTPUT = { mayBeLarge: false, boundBy: [] } satisfies OperationDef["output"];
