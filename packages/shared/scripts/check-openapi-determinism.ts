import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { renderOpenApiArtifacts } from "./openapi-artifacts.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const first = await renderOpenApiArtifacts();
const second = await renderOpenApiArtifacts();

assert.deepEqual(second, first, "two clean in-memory generations must be byte-identical");
console.log(`OpenAPI OAS sha256=${hash(first.openApiJson)}`);
console.log(`OpenAPI Web types sha256=${hash(first.webTypes)}`);
