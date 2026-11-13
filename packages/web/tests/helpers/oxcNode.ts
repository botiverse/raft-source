import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Node arguments that run a TypeScript script (packages/web/scripts/*.ts) the
 * way package.json does (`node --import @oxc-node/core/register x.ts`). The
 * loader is given as an absolute URL: a child spawned with another cwd (a temp
 * fixture root) cannot resolve the bare specifier.
 */
export const OXC_NODE_ARGS = [
  "--import",
  pathToFileURL(resolve(import.meta.dirname, "../../node_modules/@oxc-node/core/register.mjs")).href,
];
