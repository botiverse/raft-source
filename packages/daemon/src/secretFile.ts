import { readFileSync } from "node:fs";

export function readSecretFileSync(filePath: string): string {
  return readFileSync(filePath, "utf8").trim();
}
