import {
  NodeHost,
  compile,
  formatDiagnostic,
  getMaxValueAsNumeric,
  getMaxValueExclusiveAsNumeric,
  getMinValueAsNumeric,
  getMinValueExclusiveAsNumeric,
  isArrayModelType,
  isTemplateDeclaration,
} from "@typespec/compiler";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const source = resolve(root, "activity-sync.tsp");
const output = resolve(root, "generated/bindings/ActivitySync.kt");
const fixtureOutput = resolve(root, "generated/bindings/ActivitySyncContractFixtures.kt");
const contractVectorsPath = resolve(root, "fixtures/activity-sync.contract-vectors.jsonl");
const behaviorSeedPath = resolve(root, "fixtures/activity-sync.behavior.seed.jsonl");

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

const sourceBytes = await readFile(source);
const contractVectorBytes = await readFile(contractVectorsPath);
const behaviorSeedBytes = await readFile(behaviorSeedPath);
const sourceSha256 = sha256(sourceBytes);
const contractVectorsSha256 = sha256(contractVectorBytes);
const behaviorSeedSha256 = sha256(behaviorSeedBytes);

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

const kotlinKeywords = new Set([
  "as", "break", "class", "continue", "do", "else", "false", "for", "fun",
  "if", "in", "interface", "is", "null", "object", "package", "return",
  "super", "this", "throw", "true", "try", "typealias", "typeof", "val",
  "var", "when", "while",
]);

function identifier(name) {
  return kotlinKeywords.has(name) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)
    ? `\`${name}\``
    : name;
}

function upperCamel(name) {
  const words = String(name).split(/[^A-Za-z0-9]+/).filter(Boolean);
  const rendered = words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join("");
  return rendered || "Value";
}

function scalarPrimitive(scalar) {
  let current = scalar;
  while (current) {
    switch (current.name) {
      case "boolean":
        return "Boolean";
      case "string":
      case "bytes":
      case "plainDate":
      case "plainTime":
      case "utcDateTime":
      case "offsetDateTime":
      case "duration":
      case "url":
        return "String";
      case "int8":
      case "int16":
      case "int32":
        return "Int";
      case "uint8":
      case "uint16":
      case "uint32":
        return "UInt";
      case "int64":
        return "Long";
      case "uint64":
        return "ULong";
      case "float32":
        return "Float";
      case "float64":
      case "decimal":
      case "decimal128":
      case "numeric":
      case "integer":
        return "Double";
      default:
        current = current.baseScalar;
    }
  }
  throw new Error(`unsupported scalar primitive: ${scalar.name}`);
}

function unionParts(union) {
  return [...union.variants.values()].map((variant) => variant.type);
}

function renderType(type) {
  switch (type.kind) {
    case "Intrinsic":
      if (type.name === "unknown") return "JsonElement";
      if (type.name === "null") return "Nothing?";
      throw new Error(`unsupported intrinsic: ${type.name}`);
    case "String":
      return "String";
    case "Number":
      return "Long";
    case "Boolean":
      return "Boolean";
    case "Scalar":
      return type.namespace === namespace ? type.name : scalarPrimitive(type);
    case "Enum":
      return type.name;
    case "Model":
      if (isArrayModelType(type)) return `List<${renderType(type.indexer.value)}>`;
      return type.name;
    case "Union": {
      if (type.name) return type.name;
      const parts = unionParts(type);
      const nulls = parts.filter((part) => part.kind === "Intrinsic" && part.name === "null");
      const nonNulls = parts.filter((part) => !(part.kind === "Intrinsic" && part.name === "null"));
      if (nulls.length === 1 && nonNulls.length === 1) return `${renderType(nonNulls[0])}?`;
      if (parts.every((part) => part.kind === "String")) return "String";
      throw new Error(`unsupported anonymous union: ${parts.map((part) => part.kind).join(" | ")}`);
    }
    case "Tuple":
      throw new Error("tuples are not part of the frozen Activity contract");
    default:
      throw new Error(`unsupported TypeSpec type kind: ${type.kind}`);
  }
}

function literalConstraint(property) {
  const type = property.type;
  if (type.kind === "String") {
    return `${identifier(property.name)} == ${JSON.stringify(type.value)}`;
  }
  if (type.kind === "Number") {
    return `${identifier(property.name)} == ${type.valueAsString}L`;
  }
  if (type.kind === "Boolean") {
    return `${identifier(property.name)} == ${String(type.value)}`;
  }
  if (type.kind === "Union" && !type.name) {
    const parts = unionParts(type);
    if (parts.every((part) => part.kind === "String")) {
      return `${identifier(property.name)} in setOf(${parts.map((part) => JSON.stringify(part.value)).join(", ")})`;
    }
  }
  return null;
}

function numericPrimitive(type) {
  if (type.kind === "Number") return "Long";
  if (type.kind === "Scalar") return scalarPrimitive(type);
  return null;
}

function kotlinNumericLiteral(value, primitive) {
  const rendered = value.toString();
  switch (primitive) {
    case "Int":
    case "Double":
      return rendered;
    case "Long":
      return `${rendered}L`;
    case "UInt":
      return `${rendered}u`;
    case "ULong":
      return `${rendered}uL`;
    case "Float":
      return `${rendered}f`;
    default:
      throw new Error(`unsupported constrained numeric primitive: ${primitive}`);
  }
}

function numericConstraints(property) {
  const primitive = numericPrimitive(property.type);
  if (!primitive) return [];

  const targets = [property];
  let scalar = property.type.kind === "Scalar" ? property.type : null;
  while (scalar) {
    targets.push(scalar);
    scalar = scalar.baseScalar;
  }

  const propertyName = identifier(property.name);
  const constraints = [];
  const seen = new Set();
  const append = (operator, value) => {
    if (!value) return;
    const constraint = `${propertyName} ${operator} ${kotlinNumericLiteral(value, primitive)}`;
    if (!seen.has(constraint)) {
      seen.add(constraint);
      constraints.push(constraint);
    }
  };

  for (const target of targets) {
    append(">=", getMinValueAsNumeric(program, target));
    append(">", getMinValueExclusiveAsNumeric(program, target));
    append("<=", getMaxValueAsNumeric(program, target));
    append("<", getMaxValueExclusiveAsNumeric(program, target));
  }
  return constraints;
}

const namedUnions = [...namespace.unions.values()]
  .filter((type) => !isTemplateDeclaration(type))
  .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));

const discriminatedUnions = new Map();
const modelMembership = new Map();
for (const union of namedUnions) {
  const variants = [...union.variants.values()];
  if (variants.length === 0 || !variants.every((variant) => variant.type.kind === "Model")) continue;
  const branches = variants.map((variant) => {
    const model = variant.type;
    const discriminator = model.properties.get("type")?.type;
    if (!discriminator || discriminator.kind !== "String") {
      throw new Error(`${union.name} branch ${model.name} must have a string-literal type discriminator`);
    }
    return { model, wire: discriminator.value };
  });
  if (new Set(branches.map((branch) => branch.wire)).size !== branches.length) {
    throw new Error(`${union.name} discriminator values must be unique`);
  }
  discriminatedUnions.set(union.name, branches);
  for (const branch of branches) {
    const existing = modelMembership.get(branch.model.name);
    if (existing) throw new Error(`${branch.model.name} belongs to both ${existing.union} and ${union.name}`);
    modelMembership.set(branch.model.name, { union: union.name, wire: branch.wire });
  }
}

function renderScalar(scalar) {
  if (scalar.name === "UInt64String") {
    // Deliberately NOT a @JvmInline value class: `kotlin.jvm.JvmInline` does not
    // resolve in OHOS common code, so the JVM/Android canary was green while the
    // OHOS shared compile went RED. A data class is platform-neutral and keeps
    // the value semantics (equals/hashCode) the wire contract relies on.
    return `@Serializable(with = UInt64StringSerializer::class)\ndata class UInt64String(val value: String) {\n    init {\n        require(UINT64_DECIMAL_REGEX.matches(value)) { "UInt64String must be canonical unsigned decimal" }\n    }\n\n    override fun toString(): String = value\n}\n\nobject UInt64StringSerializer : KSerializer<UInt64String> {\n    override val descriptor: SerialDescriptor = PrimitiveSerialDescriptor("UInt64String", PrimitiveKind.STRING)\n\n    override fun serialize(encoder: Encoder, value: UInt64String) = encoder.encodeString(value.value)\n\n    override fun deserialize(decoder: Decoder): UInt64String = UInt64String(decoder.decodeString())\n}`;
  }
  const primitive = scalarPrimitive(scalar);
  return `typealias ${scalar.name} = ${primitive}`;
}

function renderEnum(type) {
  const members = [...type.members.values()].map((member) => {
    const wire = String(member.value ?? member.name);
    return `    @SerialName(${JSON.stringify(wire)})\n    ${upperCamel(member.name)}`;
  });
  return `@Serializable\nenum class ${type.name} {\n${members.join(",\n")}\n}`;
}

function renderModel(model) {
  const membership = modelMembership.get(model.name);
  const sourceProperties = [...model.properties.values()];
  const properties = sourceProperties.filter((property) => !(membership && property.name === "type"));
  const parameters = properties.map((property) => {
    const type = renderType(property.type);
    if (property.optional) {
      return `    val ${identifier(property.name)}: OptionalField<${type}> = OptionalField.Missing`;
    }
    return `    val ${identifier(property.name)}: ${type}`;
  });
  const constraints = properties.flatMap((property) => [
    literalConstraint(property),
    ...numericConstraints(property),
  ]).filter(Boolean);
  const implementsClause = membership ? ` : ${membership.union}` : "";
  const annotation = membership ? `@SerialName(${JSON.stringify(membership.wire)})\n` : "";
  const init = constraints.length === 0
    ? ""
    : ` {\n    init {\n${constraints.map((constraint) => `        require(${constraint})`).join("\n")}\n    }\n}`;
  return `${annotation}@Serializable\ndata class ${model.name}(\n${parameters.join(",\n")}\n)${implementsClause}${init}`;
}

function renderUnion(union) {
  const branches = discriminatedUnions.get(union.name);
  if (!branches) throw new Error(`named union ${union.name} is not a discriminated model union`);
  return `@OptIn(ExperimentalSerializationApi::class)\n@Serializable\n@JsonClassDiscriminator("type")\nsealed interface ${union.name}`;
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

const prelude = `// Generated directly from activity-sync.tsp via the TypeSpec compiler semantic graph.\n// DO NOT EDIT. JSON Schema and OpenAPI are parallel outputs, not inputs.\n// Source SHA-256: f464700d04af3d47290f6b7df21dc74f6ef36b0093fac4397f64078fd9d64b67\n@file:OptIn(ExperimentalSerializationApi::class)\n\npackage build.raft.app.network.sync.activity.contract.v1\n\nimport kotlinx.serialization.ExperimentalSerializationApi\nimport kotlinx.serialization.KSerializer\nimport kotlinx.serialization.SerialName\nimport kotlinx.serialization.Serializable\nimport kotlinx.serialization.descriptors.PrimitiveKind\nimport kotlinx.serialization.descriptors.PrimitiveSerialDescriptor\nimport kotlinx.serialization.descriptors.SerialDescriptor\nimport kotlinx.serialization.encoding.Decoder\nimport kotlinx.serialization.encoding.Encoder\nimport kotlinx.serialization.json.Json\nimport kotlinx.serialization.json.JsonClassDiscriminator\nimport kotlinx.serialization.json.JsonElement\n\nprivate val UINT64_DECIMAL_REGEX = Regex("^(0|[1-9][0-9]*)$")\n\n@Serializable(with = OptionalFieldSerializer::class)\nsealed interface OptionalField<out T> {\n    data object Missing : OptionalField<Nothing>\n    data class Present<T>(val value: T) : OptionalField<T>\n}\n\nclass OptionalFieldSerializer<T>(\n    private val valueSerializer: KSerializer<T>,\n) : KSerializer<OptionalField<T>> {\n    override val descriptor: SerialDescriptor = valueSerializer.descriptor\n\n    override fun serialize(encoder: Encoder, value: OptionalField<T>) {\n        when (value) {\n            OptionalField.Missing -> error("OptionalField.Missing must be omitted by the generated codec")\n            is OptionalField.Present -> encoder.encodeSerializableValue(valueSerializer, value.value)\n        }\n    }\n\n    override fun deserialize(decoder: Decoder): OptionalField<T> =\n        OptionalField.Present(decoder.decodeSerializableValue(valueSerializer))\n}\n\nobject ActivitySyncContractJson {\n    val strict: Json = Json {\n        ignoreUnknownKeys = false\n        isLenient = false\n        coerceInputValues = false\n        explicitNulls = true\n        encodeDefaults = false\n        classDiscriminator = "type"\n    }\n\n    inline fun <reified T> decode(bytes: String): T = strict.decodeFromString(bytes)\n    inline fun <reified T> encode(value: T): String = strict.encodeToString(value)\n}`;

const generatedPrelude = prelude
  .replace(
    "f464700d04af3d47290f6b7df21dc74f6ef36b0093fac4397f64078fd9d64b67",
    sourceSha256,
  )
  .replace(
    "\n    inline fun <reified T> decode(bytes: String): T = strict.decodeFromString(bytes)\n" +
      "    inline fun <reified T> encode(value: T): String = strict.encodeToString(value)",
    "",
  );

const metadata = `const val ACTIVITY_SYNC_TYPESPEC_SHA256: String = "${sourceSha256}"`;

const blocks = [
  generatedPrelude,
  metadata,
  ...scalars.map(renderScalar),
  ...enums.map(renderEnum),
  ...namedUnions.map(renderUnion),
  ...models.map(renderModel),
];

await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${blocks.join("\n\n")}\n`, "utf8");
const fixtureSource = `// Generated from the immutable Activity contract vectors. DO NOT EDIT.\npackage build.raft.app.network.sync.activity.contract.v1\n\nconst val ACTIVITY_SYNC_CONTRACT_VECTORS_SHA256: String = "${contractVectorsSha256}"\nconst val ACTIVITY_SYNC_BEHAVIOR_SEED_SHA256: String = "${behaviorSeedSha256}"\n\nconst val ACTIVITY_SYNC_CONTRACT_VECTORS_JSONL: String = """\n${contractVectorBytes.toString("utf8").trimEnd()}\n"""\n\nconst val ACTIVITY_SYNC_BEHAVIOR_SEED_JSONL: String = """\n${behaviorSeedBytes.toString("utf8").trimEnd()}\n"""\n`;
await writeFile(fixtureOutput, fixtureSource, "utf8");
console.log(`direct TypeSpec -> Kotlin binding: ${output}`);
console.log(`immutable fixture bytes -> Kotlin test source: ${fixtureOutput}`);
