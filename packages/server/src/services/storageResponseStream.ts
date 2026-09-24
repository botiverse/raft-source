import type { ServerResponse } from "node:http";
import type { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export function streamStorageResponse(
  source: Readable,
  response: ServerResponse,
): Promise<void> {
  return pipeline(source, response);
}

export function streamStorageResponseThrough(
  source: Readable,
  transform: Transform,
  response: ServerResponse,
): Promise<void> {
  return pipeline(source, transform, response);
}
