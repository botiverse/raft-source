// Shared §4 IPC wire codec — length-prefixed JSON frames, used by both
// the client (`lib/ipc-client.ts`) and the server
// (`internal/ipc-server.ts`).
//
// Wire layout (RFC v9.8 §4.2):
//   +---------------------+--------------------------+
//   | 4 bytes (uint32 BE) | UTF-8 JSON body N bytes  |
//   +---------------------+--------------------------+
//          length = N
//
// Max frame size = 1 MiB; over-size frames throw `IPC_FRAME_TOO_LARGE`,
// malformed JSON throws `IPC_MALFORMED_FRAME`. Both ends share this
// module so the wire bytes can never drift between roles — one place
// to change for any codec evolution. Client commit 1 (PR #2272) had
// these helpers inline; commit 2 extracts so the server consumes the
// identical decoder/encoder rather than maintaining a parallel copy
// (`feedback_closed_set_discipline.md` rule 3 — verify-the-verifier;
// here, single-source-of-truth on the wire layer).
//
// Package-private: NOT exposed via `@botiverse/raft-computer/lib`. The lib
// barrel re-exports the closed-set `IPC_ERROR_CODES` and the
// `ServiceClientError` envelope; the codec itself is implementation
// detail that both ends import directly within the package.
import { ServiceClientError } from "../lib/types.js";

export const MAX_FRAME_BYTES = 1024 * 1024;

export function encodeFrame(payload: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(payload), "utf8");
  if (json.length > MAX_FRAME_BYTES) {
    throw new ServiceClientError(
      "IPC_FRAME_TOO_LARGE",
      `outgoing frame ${json.length} bytes exceeds MAX_FRAME_BYTES ${MAX_FRAME_BYTES}`,
    );
  }
  const header = Buffer.alloc(4);
  header.writeUInt32BE(json.length, 0);
  return Buffer.concat([header, json]);
}

/**
 * Streaming frame decoder. Pass new socket chunks to `.push(chunk)` and
 * call `.drain()` to pop fully-formed frame bodies (as parsed JS values).
 * Over-size frames throw `IPC_FRAME_TOO_LARGE`; malformed JSON throws
 * `IPC_MALFORMED_FRAME`.
 */
export class FrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
  }

  drain(): unknown[] {
    const frames: unknown[] = [];
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32BE(0);
      if (length > MAX_FRAME_BYTES) {
        throw new ServiceClientError(
          "IPC_FRAME_TOO_LARGE",
          `incoming frame ${length} bytes exceeds MAX_FRAME_BYTES ${MAX_FRAME_BYTES}`,
        );
      }
      if (this.buffer.length < 4 + length) break;
      const body = this.buffer.subarray(4, 4 + length);
      this.buffer = this.buffer.subarray(4 + length);
      let parsed: unknown;
      try {
        parsed = JSON.parse(body.toString("utf8"));
      } catch (cause) {
        throw new ServiceClientError("IPC_MALFORMED_FRAME", "frame body is not valid UTF-8 JSON", cause);
      }
      frames.push(parsed);
    }
    return frames;
  }
}
