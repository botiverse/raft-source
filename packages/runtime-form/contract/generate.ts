#!/usr/bin/env node
// Generates the runtime form v2 wire types from contract/runtime-form-v2.contract.json:
//   src/generated/runtimeFormV2.ts               TypeScript (server + web)
//   generated/kotlin/RuntimeFormV2.kt            Kotlin (mobile; copy into botiverse/mobile)
//   generated/runtime-form-v2.schema.json        JSON Schema (sample validation)
// `--check` fails when a generated file is stale instead of writing it.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const contractPath = resolve(root, "contract/runtime-form-v2.contract.json");
const contractBytes = readFileSync(contractPath);
const contract = JSON.parse(contractBytes.toString("utf8"));
const sourceHash = createHash("sha256").update(contractBytes).digest("hex").slice(0, 16);
const banner = `Generated from packages/runtime-form/contract/runtime-form-v2.contract.json (sha256 ${sourceHash}). Do not edit.`;
const typeNames = Object.keys(contract.types);

function parseType(type) {
  if (type.endsWith("[]")) return { kind: "array", of: parseType(type.slice(0, -2)) };
  const map = /^map<(.+)>$/.exec(type);
  if (map) return { kind: "map", of: parseType(map[1]) };
  if (["string", "int", "bool", "json"].includes(type)) return { kind: type };
  if (!typeNames.includes(type)) throw new Error(`unknown type ${type}`);
  return { kind: "ref", name: type };
}

// ---- TypeScript
function tsType(t, field) {
  if (field?.const !== undefined) return JSON.stringify(field.const);
  if (field?.enum) return field.enum.map((value) => JSON.stringify(value)).join(" | ");
  switch (t.kind) {
    case "string": return "string";
    case "int": return "number";
    case "bool": return "boolean";
    case "json": return "unknown";
    case "array": return `${tsType(t.of)}[]`;
    case "map": return `Record<string, ${tsType(t.of)}>`;
    case "ref": return `${contract.name}${t.name}`;
  }
}
const tsKey = (name) => (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name));

let ts = `// ${banner}\n// Every type is open: a receiver must ignore keys it does not know.\n`;
for (const [name, type] of Object.entries(contract.types)) {
  ts += `\n${type.doc ? `/** ${type.doc} */\n` : ""}export interface ${contract.name}${name} {\n`;
  for (const [fieldName, field] of Object.entries(type.fields)) {
    if (field.doc) ts += `  /** ${field.doc} */\n`;
    ts += `  ${tsKey(fieldName)}${field.optional ? "?" : ""}: ${tsType(parseType(field.type), field)};\n`;
  }
  ts += "  [key: string]: unknown;\n}\n";
}

// ---- Kotlin
function ktType(t) {
  switch (t.kind) {
    case "string": return "String";
    case "int": return "Int";
    case "bool": return "Boolean";
    case "json": return "JsonElement";
    case "array": return `List<${ktType(t.of)}>`;
    case "map": return `Map<String, ${ktType(t.of)}>`;
    case "ref": return `${contract.name}${t.name}`;
  }
}
// Kotlin hard keywords cannot be property names without backticks; a contract
// field named like one must declare kotlinName (e.g. VisibilityRule.when -> condition).
const kotlinHardKeywords = new Set([
  "as", "break", "class", "continue", "do", "else", "false", "for", "fun", "if", "in",
  "interface", "is", "null", "object", "package", "return", "super", "this", "throw",
  "true", "try", "typealias", "typeof", "val", "var", "when", "while",
]);
for (const [name, type] of Object.entries(contract.types)) {
  for (const [fieldName, field] of Object.entries(type.fields)) {
    const property = field.kotlinName ?? fieldName;
    if (kotlinHardKeywords.has(property) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(property)) {
      throw new Error(`${name}.${fieldName}: "${property}" is not a valid Kotlin property name; set kotlinName in the contract`);
    }
  }
}

let kt = `// ${banner}\n// Decode with Json { ignoreUnknownKeys = true }: every type is open.\n` +
  `// Enumerated strings stay String so an unknown value never fails decoding.\n` +
  `package ${contract.kotlinPackage}\n\n` +
  "import kotlinx.serialization.SerialName\nimport kotlinx.serialization.Serializable\nimport kotlinx.serialization.json.JsonElement\n";
for (const [name, type] of Object.entries(contract.types)) {
  kt += `\n${type.doc ? `/** ${type.doc} */\n` : ""}@Serializable\ndata class ${contract.name}${name}(\n`;
  for (const [fieldName, field] of Object.entries(type.fields)) {
    const property = field.kotlinName ?? fieldName;
    const serialName = property === fieldName ? "" : `@SerialName(${JSON.stringify(fieldName)}) `;
    const allowed = field.enum ? ` // one of ${field.enum.join(", ")}` : field.const !== undefined ? ` // always ${JSON.stringify(field.const)}` : "";
    const base = ktType(parseType(field.type));
    if (field.doc) kt += `    /** ${field.doc} */\n`;
    kt += `    ${serialName}val ${property}: ${field.optional ? `${base}? = null` : base},${allowed}\n`;
  }
  kt += ")\n";
}

// ---- JSON Schema
function schemaFor(t, field) {
  const out = (() => {
    switch (t.kind) {
      case "string": return { type: "string" };
      case "int": return { type: "integer" };
      case "bool": return { type: "boolean" };
      case "json": return {};
      case "array": return { type: "array", items: schemaFor(t.of) };
      case "map": return { type: "object", additionalProperties: schemaFor(t.of) };
      case "ref": return { $ref: `#/$defs/${t.name}` };
    }
  })();
  if (field?.const !== undefined) out.const = field.const;
  if (field?.enum) out.enum = field.enum;
  return out;
}
const defs = {};
for (const [name, type] of Object.entries(contract.types)) {
  defs[name] = {
    type: "object",
    ...(type.doc ? { description: type.doc } : {}),
    required: Object.entries(type.fields).filter(([, field]) => !field.optional).map(([fieldName]) => fieldName),
    properties: Object.fromEntries(Object.entries(type.fields).map(([fieldName, field]) => [fieldName, schemaFor(parseType(field.type), field)])),
    additionalProperties: true,
  };
}
const schema = `${JSON.stringify({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $comment: banner,
  $defs: defs,
}, null, 2)}\n`;

const outputs = [
  [resolve(root, "src/generated/runtimeFormV2.ts"), ts],
  [resolve(root, "generated/kotlin/RuntimeFormV2.kt"), kt],
  [resolve(root, "generated/runtime-form-v2.schema.json"), schema],
];
const check = process.argv.includes("--check");
let stale = false;
for (const [path, content] of outputs) {
  let current = null;
  try { current = readFileSync(path, "utf8"); } catch { /* missing */ }
  if (current === content) continue;
  if (check) {
    process.stderr.write(`stale: ${path} (run pnpm --filter @botiverse/raft-runtime-form contract:generate)\n`);
    stale = true;
  } else {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
}
process.exit(stale ? 1 : 0);
