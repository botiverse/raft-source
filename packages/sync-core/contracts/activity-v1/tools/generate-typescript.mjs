import {
  NodeHost,
  compile,
  formatDiagnostic,
  getPattern,
  isArrayModelType,
  isTemplateDeclaration,
} from "@typespec/compiler";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const source = resolve(root, "activity-sync.tsp");
const output = resolve(root, "generated/bindings/activity-sync.ts");

const program = await compile(NodeHost, source, { noEmit: true });
if (program.hasError()) {
  for (const diagnostic of program.diagnostics) {
    process.stderr.write(`${formatDiagnostic(diagnostic)}\n`);
  }
  process.exit(1);
}

let namespace = program.getGlobalNamespaceType();
for (const segment of ["Raft", "ActivitySync", "V1"]) {
  const child = namespace.namespaces.get(segment);
  if (!child) throw new Error(`namespace segment not found: ${segment}`);
  namespace = child;
}

function scalarPrimitive(scalar) {
  let current = scalar;
  while (current.baseScalar) current = current.baseScalar;
  switch (current.name) {
    case "boolean":
      return "boolean";
    case "string":
    case "bytes":
    case "plainDate":
    case "plainTime":
    case "utcDateTime":
    case "offsetDateTime":
    case "duration":
    case "url":
      return "string";
    default:
      return "number";
  }
}

function renderType(type) {
  switch (type.kind) {
    case "Intrinsic":
      if (type.name === "unknown") return "unknown";
      if (type.name === "null") return "null";
      if (type.name === "never") return "never";
      if (type.name === "void") return "void";
      throw new Error(`unsupported intrinsic: ${type.name}`);
    case "String":
      return JSON.stringify(type.value);
    case "Number":
      return type.valueAsString;
    case "Boolean":
      return String(type.value);
    case "Scalar":
      return type.namespace === namespace ? type.name : scalarPrimitive(type);
    case "Enum":
    case "Model":
      if (type.kind === "Model" && isArrayModelType(type)) {
        return `ReadonlyArray<${renderType(type.indexer.value)}>`;
      }
      return type.name;
    case "Union":
      return [...type.variants.values()].map((variant) => renderType(variant.type)).join(" | ");
    case "Tuple":
      return `readonly [${type.values.map(renderType).join(", ")}]`;
    default:
      throw new Error(`unsupported TypeSpec type kind: ${type.kind}`);
  }
}

function renderScalar(scalar) {
  const pattern = getPattern(program, scalar);
  const constraint = pattern
    ? `/** Runtime-only constraint: ${JSON.stringify(pattern)}. Static TypeScript cannot enforce this pattern. */\n`
    : "";
  return `${constraint}export type ${scalar.name} = ${scalarPrimitive(scalar)};`;
}

function renderEnum(type) {
  const values = [...type.members.values()].map((member) =>
    JSON.stringify(member.value ?? member.name)
  );
  return `export type ${type.name} = ${values.join(" | ")};`;
}

function renderModel(model) {
  const properties = [...model.properties.values()].map((property) => {
    const optional = property.optional ? "?" : "";
    return `  readonly ${property.name}${optional}: ${renderType(property.type)};`;
  });
  return `export interface ${model.name} {\n${properties.join("\n")}\n}`;
}

function renderUnion(union) {
  const variants = [...union.variants.values()].map((variant) => renderType(variant.type));
  return `export type ${union.name} =\n${variants.map((type) => `  | ${type}`).join("\n")};`;
}

const scalars = [...namespace.scalars.values()]
  .filter((type) => !isTemplateDeclaration(type))
  .sort((a, b) => a.name.localeCompare(b.name));
const enums = [...namespace.enums.values()]
  .filter((type) => !isTemplateDeclaration(type))
  .sort((a, b) => a.name.localeCompare(b.name));
const models = [...namespace.models.values()]
  .filter((type) => !isTemplateDeclaration(type))
  .sort((a, b) => a.name.localeCompare(b.name));
const unions = [...namespace.unions.values()]
  .filter((type) => !isTemplateDeclaration(type))
  .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));

const blocks = [
  "// Generated directly from activity-sync.tsp via the TypeSpec compiler semantic graph.",
  "// DO NOT EDIT. JSON Schema and OpenAPI are parallel outputs, not inputs.",
  "// Runtime raw-byte validation remains mandatory; TypeScript types are erased.",
  "",
  ...scalars.map(renderScalar),
  ...enums.map(renderEnum),
  ...models.map(renderModel),
  ...unions.map(renderUnion),
  "",
];

await mkdir(dirname(output), { recursive: true });
// Trim trailing blank lines: a block that already ends in a newline made the
// file finish with a blank line at EOF, which `git diff --check` flags.
await writeFile(output, `${blocks.join("\n\n").replace(/\n+$/, "")}\n`, "utf8");
console.log(`direct TypeSpec -> TypeScript binding: ${output}`);
