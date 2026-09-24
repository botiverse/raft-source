import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

async function newestInput(path) {
  const metadata = await stat(path);
  if (!metadata.isDirectory()) return { path, mtimeMs: metadata.mtimeMs };

  let newest = null;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const entryPath = join(path, entry.name);
    if (!entry.isDirectory() && !entry.isFile()) continue;
    const candidate = await newestInput(entryPath);
    if (!newest || candidate.mtimeMs > newest.mtimeMs) newest = candidate;
  }
  return newest ?? { path, mtimeMs: metadata.mtimeMs };
}

export async function assertBuildOutputFresh({
  dependency,
  inputs,
  output,
  recovery,
}) {
  let outputMetadata;
  try {
    outputMetadata = await stat(output);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    throw new Error(
      `${dependency} build output is missing at ${output}. Run \`${recovery}\` before the native build.`,
    );
  }

  let newest = null;
  for (const input of inputs) {
    const candidate = await newestInput(input);
    if (!newest || candidate.mtimeMs > newest.mtimeMs) newest = candidate;
  }

  if (newest && outputMetadata.mtimeMs < newest.mtimeMs) {
    throw new Error(
      `${dependency} build output is stale: ${newest.path} is newer than ${output}. ` +
        `Run \`${recovery}\` before the native build.`,
    );
  }
}
