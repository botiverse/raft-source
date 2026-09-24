import type { Response } from "express";
import type { Brand } from "@botiverse/raft-shared";
import { UUID_RE } from "./messageId.js";

/**
 * Parse a branded-UUID id out of an untyped request body.
 *
 * `req.body` is `any`, so a destructured `req.body.machineId` is also `any` and
 * silently satisfies a branded-id parameter — `any` is assignable to anything,
 * so the brand provides ZERO protection until the value is actually validated
 * at this boundary. This is the runtime gate that makes the brand meaningful:
 * check the UUID shape, then mint the brand; on failure write a 400 and return
 * null so the caller bails:
 *
 *   const machineId = parseBrandedUuidFromBody(req.body.machineId, asMachineId, "machineId", res);
 *   if (!machineId) return;
 *
 * The same `as*Id` constructor and id semantics are shared across MachineId /
 * ServerId / ChannelId, so one factory (UUID_RE single source) serves them all.
 */
export function parseBrandedUuidFromBody<B extends string>(
  raw: unknown,
  brand: (value: string) => Brand<string, B>,
  fieldName: string,
  res: Response,
): Brand<string, B> | null {
  if (typeof raw !== "string" || !UUID_RE.test(raw)) {
    res.status(400).json({ error: `Invalid ${fieldName}: must be a UUID` });
    return null;
  }
  return brand(raw);
}
