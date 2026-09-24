import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { SpawnContext } from "./drivers/types.js";

function safePathPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 96) || "unknown";
}

export function readSecretFileSync(filePath: string): string {
  return readFileSync(filePath, "utf8").trim();
}

export function writeSecretFileSync(filePath: string, secret: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  writeFileSync(filePath, secret, { mode: 0o600 });
  chmodSync(filePath, 0o600);
}

export function writeRuntimeActionTokenFile(ctx: SpawnContext, runtimeId: string): string {
  const token = ctx.config.authToken || ctx.daemonApiKey;
  const launchPart = safePathPart(ctx.launchId || `pid-${process.pid}`);
  const tokenDir = path.join(ctx.workingDirectory, ".slock", "runtime-action-tokens");
  const tokenFile = path.join(tokenDir, `${safePathPart(runtimeId)}-${launchPart}.token`);
  writeSecretFileSync(tokenFile, token);
  return tokenFile;
}
