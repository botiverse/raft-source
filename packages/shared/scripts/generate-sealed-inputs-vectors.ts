// Rewrites packages/shared/src/sealedInputs.v1.vector.json and its .sha256
// (RFC 086 §5.3, the shared sealing vectors) from sealedInputsVectors.testkit.ts.
// Deterministic: an unchanged generator and jose version write the same bytes.
// After a change, tell the web, mobile and Vault owners to re-sync.
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { basename } from "node:path";
import { SEALED_INPUTS_VECTOR_PATH, SEALED_INPUTS_VECTOR_SHA256_PATH, sealedInputsVectorText } from "../src/sealedInputsVectors.testkit";

const text = await sealedInputsVectorText();
writeFileSync(SEALED_INPUTS_VECTOR_PATH, text);
writeFileSync(SEALED_INPUTS_VECTOR_SHA256_PATH, `${createHash("sha256").update(text, "utf8").digest("hex")}  ${basename(SEALED_INPUTS_VECTOR_PATH)}\n`);
console.log(`wrote ${SEALED_INPUTS_VECTOR_PATH}`);
