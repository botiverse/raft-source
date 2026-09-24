import type { Readable } from "node:stream";

export async function readStreamPrefix(stream: Readable, byteLimit: number): Promise<{ buffer: Buffer; truncated: boolean }> {
  const chunks: Buffer[] = [];
  let total = 0;
  let truncated = false;

  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const remaining = byteLimit - total;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    if (buffer.length > remaining) {
      chunks.push(buffer.subarray(0, remaining));
      total += remaining;
      truncated = true;
      break;
    }
    chunks.push(buffer);
    total += buffer.length;
  }

  stream.destroy();
  return { buffer: Buffer.concat(chunks, total), truncated };
}
