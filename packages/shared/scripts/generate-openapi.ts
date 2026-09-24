import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { renderOpenApiArtifacts } from "./openapi-artifacts.js";

const packageRoot = resolve(import.meta.dirname, "..");
const openApiFile = resolve(packageRoot, "openapi/openapi.json");
const webTypesFile = resolve(packageRoot, "src/generated/openapi.ts");
const artifacts = await renderOpenApiArtifacts();

mkdirSync(resolve(packageRoot, "openapi"), { recursive: true });
mkdirSync(resolve(packageRoot, "src/generated"), { recursive: true });
writeFileSync(openApiFile, artifacts.openApiJson);
writeFileSync(webTypesFile, artifacts.webTypes);
