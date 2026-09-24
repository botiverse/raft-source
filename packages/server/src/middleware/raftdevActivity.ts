import type { NextFunction, Request, Response } from "express";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const ACTIVITY_FILE_ENV = "SLOCKDEV_LAST_ACTIVITY_FILE";

export function shouldRecordRaftdevActivity(method: string, path: string): boolean {
  if (method.toUpperCase() === "OPTIONS") return false;
  if (path === "/health" || path === "/metrics") return false;
  if (path === "/internal" || path.startsWith("/internal/")) return false;
  return true;
}

export function raftdevActivityMiddleware(req: Request, _res: Response, next: NextFunction): void {
  const activityFile = process.env[ACTIVITY_FILE_ENV]?.trim();
  if (!activityFile || !shouldRecordRaftdevActivity(req.method, req.path)) {
    next();
    return;
  }

  try {
    mkdirSync(dirname(activityFile), { recursive: true });
    writeFileSync(activityFile, `${Math.floor(Date.now() / 1000)}\n`);
  } catch (err) {
    console.warn("[raftdev] failed to record request activity", (err as Error).message);
  }
  next();
}
