import type { ValidatedScreenshot } from "./screenshotBudget";

const encoder = new TextEncoder();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function view(size: number): { bytes: Uint8Array; data: DataView } {
  const bytes = new Uint8Array(size);
  return { bytes, data: new DataView(bytes.buffer) };
}

export function screenshotPageFilename(filename: string, page: number, count: number): string {
  if (count <= 1) return filename;
  const stem = filename.replace(/\.png$/i, "") || "raft-export";
  const digits = String(count).length;
  return `${stem}-${String(page).padStart(digits, "0")}-of-${count}.png`;
}

/** Build a deterministic, uncompressed ZIP without adding a runtime library. */
export async function createScreenshotZip(
  images: readonly ValidatedScreenshot[],
  filename: string,
): Promise<Blob> {
  const entries = await Promise.all(images.map(async (image, index) => ({
    name: encoder.encode(screenshotPageFilename(filename, index + 1, images.length)),
    body: new Uint8Array(await image.blob.arrayBuffer()),
  })));
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const checksum = crc32(entry.body);
    const local = view(30 + entry.name.length);
    local.data.setUint32(0, 0x04034b50, true);
    local.data.setUint16(4, 20, true);
    local.data.setUint16(6, 0x0800, true);
    local.data.setUint16(8, 0, true);
    local.data.setUint32(14, checksum, true);
    local.data.setUint32(18, entry.body.length, true);
    local.data.setUint32(22, entry.body.length, true);
    local.data.setUint16(26, entry.name.length, true);
    local.bytes.set(entry.name, 30);
    localParts.push(local.bytes, entry.body);

    const central = view(46 + entry.name.length);
    central.data.setUint32(0, 0x02014b50, true);
    central.data.setUint16(4, 20, true);
    central.data.setUint16(6, 20, true);
    central.data.setUint16(8, 0x0800, true);
    central.data.setUint16(10, 0, true);
    central.data.setUint32(16, checksum, true);
    central.data.setUint32(20, entry.body.length, true);
    central.data.setUint32(24, entry.body.length, true);
    central.data.setUint16(28, entry.name.length, true);
    central.data.setUint32(42, offset, true);
    central.bytes.set(entry.name, 46);
    centralParts.push(central.bytes);
    offset += local.bytes.length + entry.body.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = view(22);
  end.data.setUint32(0, 0x06054b50, true);
  end.data.setUint16(8, entries.length, true);
  end.data.setUint16(10, entries.length, true);
  end.data.setUint32(12, centralSize, true);
  end.data.setUint32(16, offset, true);
  const parts = [...localParts, ...centralParts, end.bytes];
  const totalSize = parts.reduce((sum, part) => sum + part.length, 0);
  const archive = new Uint8Array(totalSize);
  let cursor = 0;
  for (const part of parts) {
    archive.set(part, cursor);
    cursor += part.length;
  }
  return new Blob([archive.buffer], { type: "application/zip" });
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
