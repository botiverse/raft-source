// Stands in for @aws-sdk/client-bedrock-runtime and @smithy/node-http-handler
// inside the SEA's computer.cjs. Only pi-ai's Bedrock stream imports them, and
// pi-ai imports that stream on the first Bedrock request, so this runs then:
// the SEA loader compiles both packages from their shared asset (seaEntries.mjs
// SEA_ASSET_BEDROCK), which exports the names of both.
const load = globalThis[Symbol.for("raft.sea.loadLazyAsset")];
if (typeof load !== "function") throw new Error("raft-computer: the SEA loader did not install the lazy asset hook");
module.exports = load("@aws-sdk/client-bedrock-runtime");
