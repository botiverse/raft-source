// Project an operation's zod request schema to the conservative JSON Schema
// subset the operation manifest promises gateways (and model providers with
// partial JSON Schema support):
//
//   inline objects (`type`, `properties`, `required`), arrays (`items`),
//   one primitive `type` name (never a type array), `enum`, `description`,
//   `minimum` / `maximum`, `minLength` / `maxLength`.
//
// No `$ref` / `$defs`, no `oneOf` / `anyOf` / `allOf`, no `const`. The
// projection accepts nothing the zod schema the operation validates with
// rejects, and omits nothing a model needs (zod stays the runtime check):
//
// - `const` becomes a one-value `enum`;
// - a nullable field is projected as its non-null type and must be optional
//   (omitting it is the JSON spelling; the runtime also still accepts null) —
//   a required nullable field fails generation;
// - any other union of primitives fails generation unless the operation names
//   the one type to advertise (`unionAs`), for a field whose runtime treats
//   that spelling the same (`messages.read` `around`: a seq is accepted as a
//   number or as its string);
// - a discriminated union of objects is flattened into one object: the
//   discriminator becomes a required `enum`, every other field is optional,
//   and each field's description says which variants use it; a field shared
//   by variants with different constraints keeps only the loosest bounds;
// - keywords outside the subset (`format`, `pattern`, `default`,
//   `additionalProperties`, `minItems`, …) are dropped, which only loosens;
// - `exclusiveMinimum` / `exclusiveMaximum` become the inclusive bound
//   (exact for integers, looser for numbers); the ±2^53 bounds zod emits for
//   `.int()` are dropped.

import { z } from "zod";

export type RaftJsonSchemaType = "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";

export interface RaftJsonSchema {
  type?: RaftJsonSchemaType;
  description?: string;
  properties?: Record<string, RaftJsonSchema>;
  required?: string[];
  items?: RaftJsonSchema;
  enum?: Array<string | number | boolean | null>;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
}

/** Every keyword the subset allows. */
export const RAFT_JSON_SCHEMA_KEYWORDS: readonly (keyof RaftJsonSchema)[] = [
  "type", "description", "properties", "required", "items", "enum", "minimum", "maximum", "minLength", "maxLength",
];

const PRIMITIVES = new Set<string>(["string", "number", "integer", "boolean", "null"]);
const SAFE = Number.MAX_SAFE_INTEGER;

type Raw = Record<string, unknown>;

function isRaw(value: unknown): value is Raw {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function jsonTypeOf(value: unknown): RaftJsonSchemaType {
  if (value === null) return "null";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  if (typeof value === "boolean") return "boolean";
  return "string";
}

interface ProjectOptions {
  /** Field path (`where`) → the single primitive type to advertise for a union of primitives. */
  unionAs: Readonly<Record<string, RaftJsonSchemaType>>;
}

function project(node: unknown, where: string, options: ProjectOptions): RaftJsonSchema {
  if (!isRaw(node)) throw new Error(`${where}: not a JSON Schema object`);
  const branches = (node.anyOf ?? node.oneOf) as unknown;
  if (Array.isArray(branches)) {
    const projected = branches.map((branch, index) => project(branch, `${where}|${index}`, options));
    const flattened = projected.every((b) => b.type !== undefined && b.type !== "array" && b.type !== "object")
      ? primitiveUnion(projected, where, options)
      : flattenDiscriminatedUnion(projected, where);
    return typeof node.description === "string" ? { ...flattened, description: node.description } : flattened;
  }
  if (node.allOf !== undefined || node.$ref !== undefined || node.not !== undefined) {
    throw new Error(`${where}: allOf / $ref / not cannot be projected to the tool-schema subset`);
  }
  const out: RaftJsonSchema = {};
  if (node.type !== undefined) {
    const typeValue = Array.isArray(node.type)
      ? node.type.filter((t) => t !== "null")
      : [node.type];
    if (typeValue.length !== 1) throw new Error(`${where}: type arrays are outside the tool-schema subset`);
    const type = String(typeValue[0]);
    if (type !== "object" && type !== "array" && !PRIMITIVES.has(type)) throw new Error(`${where}: unknown type ${type}`);
    out.type = type as RaftJsonSchemaType;
  }
  if (typeof node.description === "string") out.description = node.description;
  if (node.const !== undefined) {
    out.enum = [node.const as string];
    out.type ??= jsonTypeOf(node.const);
  }
  if (Array.isArray(node.enum)) out.enum = [...node.enum] as RaftJsonSchema["enum"];
  if (isRaw(node.properties)) {
    out.properties = {};
    const required = Array.isArray(node.required) ? node.required as string[] : [];
    for (const [key, value] of Object.entries(node.properties)) {
      if (required.includes(key) && isNullable(value)) {
        throw new Error(`${where}.${key}: a required nullable field has no tool-schema form; make it optional (omitted = null)`);
      }
      out.properties[key] = project(value, `${where}.${key}`, options);
    }
    out.type ??= "object";
  }
  if (Array.isArray(node.required) && node.required.length > 0) out.required = [...node.required] as string[];
  if (node.items !== undefined) out.items = project(node.items, `${where}[]`, options);
  const integer = out.type === "integer";
  const lower = [
    typeof node.minimum === "number" ? node.minimum : undefined,
    typeof node.exclusiveMinimum === "number" ? node.exclusiveMinimum + (integer ? 1 : 0) : undefined,
  ].filter((v): v is number => v !== undefined && v > -SAFE);
  const upper = [
    typeof node.maximum === "number" ? node.maximum : undefined,
    typeof node.exclusiveMaximum === "number" ? node.exclusiveMaximum - (integer ? 1 : 0) : undefined,
  ].filter((v): v is number => v !== undefined && v < SAFE);
  if (lower.length > 0) out.minimum = Math.max(...lower);
  if (upper.length > 0) out.maximum = Math.min(...upper);
  if (typeof node.minLength === "number" && node.minLength > 0) out.minLength = node.minLength;
  if (typeof node.maxLength === "number") out.maxLength = node.maxLength;
  return out;
}

function isNullable(node: unknown): boolean {
  if (!isRaw(node)) return false;
  const branches = (node.anyOf ?? node.oneOf) as unknown;
  const typeArray = Array.isArray(node.type) && (node.type as unknown[]).includes("null");
  return node.type === "null" || typeArray || (Array.isArray(branches) && branches.some((b) => isRaw(b) && b.type === "null"));
}

/**
 * `T | null` → `T` (the field is optional, so omitting it is the JSON form of
 * null); any other union of primitives → the type the operation names in
 * `unionAs`. The branch constraints are dropped (looser).
 */
function primitiveUnion(branches: RaftJsonSchema[], where: string, options: ProjectOptions): RaftJsonSchema {
  const types: RaftJsonSchemaType[] = [...new Set(branches.map((b) => b.type!).filter((t) => t !== "null"))];
  if (types.length === 1) return { type: types[0]! };
  const chosen = options.unionAs[where];
  if (!chosen || !types.includes(chosen)) {
    throw new Error(`${where}: a union of ${types.join(" | ")} needs unionAs (the one type to advertise)`);
  }
  return { type: chosen };
}

/** The one property every object branch pins to a distinct single value. */
function discriminatorOf(branches: RaftJsonSchema[]): string | null {
  const first = branches[0];
  if (!first?.properties) return null;
  for (const key of Object.keys(first.properties)) {
    const values = branches.map((b) => b.properties?.[key]?.enum);
    if (values.every((v) => Array.isArray(v) && v.length === 1) && new Set(values.map((v) => v![0])).size === branches.length) return key;
  }
  return null;
}

function flattenDiscriminatedUnion(branches: RaftJsonSchema[], where: string): RaftJsonSchema {
  if (!branches.every((b) => b.type === "object")) {
    throw new Error(`${where}: only unions of primitives or discriminated unions of objects can be projected`);
  }
  const discriminator = discriminatorOf(branches);
  if (!discriminator) throw new Error(`${where}: a union of objects needs a discriminator property to be flattened`);
  const tags = branches.map((b) => b.properties![discriminator]!.enum![0] as string);
  const properties: Record<string, RaftJsonSchema> = {
    [discriminator]: {
      type: "string",
      enum: tags,
      description: `Which variant this is; the other fields apply per ${discriminator} as their descriptions say.`,
    },
  };
  const order: string[] = [];
  const byKey = new Map<string, Array<{ tag: string; schema: RaftJsonSchema }>>();
  branches.forEach((branch, index) => {
    for (const [key, schema] of Object.entries(branch.properties ?? {})) {
      if (key === discriminator) continue;
      if (!byKey.has(key)) {
        byKey.set(key, []);
        order.push(key);
      }
      byKey.get(key)!.push({ tag: tags[index]!, schema });
    }
  });
  for (const key of order) {
    const uses = byKey.get(key)!;
    const merged = uses.map((u) => u.schema).reduce(loosest);
    const descriptions = [...new Set(uses.map((u) => u.schema.description).filter((d): d is string => Boolean(d)))];
    const usedBy = uses.length === branches.length ? "" : `Only for ${discriminator} ${uses.map((u) => u.tag).join(", ")}.`;
    const description = [...descriptions, usedBy].filter(Boolean).join(" ");
    const { description: _drop, ...rest } = merged;
    properties[key] = description ? { ...rest, description } : rest;
  }
  return { type: "object", properties, required: [discriminator] };
}

/** The loosest schema accepting everything either side accepts (within the subset). */
function loosest(a: RaftJsonSchema, b: RaftJsonSchema): RaftJsonSchema {
  if (JSON.stringify(a) === JSON.stringify(b)) return a;
  const out: RaftJsonSchema = {};
  if (a.type !== undefined && a.type === b.type) out.type = a.type;
  if (a.enum && b.enum) out.enum = [...new Set([...a.enum, ...b.enum])];
  if (a.minimum !== undefined && b.minimum !== undefined) out.minimum = Math.min(a.minimum, b.minimum);
  if (a.maximum !== undefined && b.maximum !== undefined) out.maximum = Math.max(a.maximum, b.maximum);
  if (a.minLength !== undefined && b.minLength !== undefined) out.minLength = Math.min(a.minLength, b.minLength);
  if (a.maxLength !== undefined && b.maxLength !== undefined) out.maxLength = Math.max(a.maxLength, b.maxLength);
  if (a.items && b.items) out.items = loosest(a.items, b.items);
  if (a.properties && b.properties) {
    out.properties = {};
    for (const key of new Set([...Object.keys(a.properties), ...Object.keys(b.properties)])) {
      const pa = a.properties[key];
      const pb = b.properties[key];
      out.properties[key] = pa && pb ? loosest(pa, pb) : (pa ?? pb)!;
    }
    const required = (a.required ?? []).filter((key) => (b.required ?? []).includes(key));
    if (required.length > 0) out.required = required;
  }
  if (a.description) out.description = a.description;
  return out;
}

/** The tool-schema projection of an operation's zod request schema (input side). */
export function toRaftToolInputSchema(
  schema: z.ZodType,
  options: {
    omit?: readonly string[];
    describe?: Readonly<Record<string, string>>;
    /** Top-level field → the one primitive type to advertise for a union of primitives. */
    unionAs?: Readonly<Record<string, RaftJsonSchemaType>>;
  } = {},
): RaftJsonSchema {
  const raw = z.toJSONSchema(schema, { io: "input", target: "draft-2020-12", reused: "inline", unrepresentable: "throw" });
  const unionAs = Object.fromEntries(Object.entries(options.unionAs ?? {}).map(([key, type]) => [`input.${key}`, type]));
  const projected = project(raw, "input", { unionAs });
  if (projected.type !== "object") throw new Error("an operation's input schema must be an object");
  for (const key of options.omit ?? []) {
    if (projected.properties) delete projected.properties[key];
    if (projected.required) projected.required = projected.required.filter((r) => r !== key);
  }
  for (const [key, description] of Object.entries(options.describe ?? {})) {
    const property = projected.properties?.[key];
    if (!property) throw new Error(`cannot describe unknown field ${key}`);
    property.description = description;
  }
  if (projected.required?.length === 0) delete projected.required;
  projected.properties ??= {};
  return projected;
}
