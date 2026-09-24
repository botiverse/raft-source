import type { MermaidRenderResult } from "./mermaidRenderer";

function contentHash(content: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < content.length; index += 1) {
    hash ^= content.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function diagramFilename(content: string, extension: "mmd" | "svg" | "png") {
  return `mermaid-${contentHash(content)}.${extension}`;
}

export async function svgToPngBlob(
  result: MermaidRenderResult,
  messages: {
    imageLoadError: string;
    canvasUnavailable: string;
    createError: string;
  },
): Promise<Blob> {
  const maxDimension = Math.max(result.width, result.height);
  const scale = Math.min(2, 4096 / Math.max(1, maxDimension));
  const width = Math.max(1, Math.round(result.width * scale));
  const height = Math.max(1, Math.round(result.height * scale));
  const source = URL.createObjectURL(new Blob([result.svg], { type: "image/svg+xml;charset=utf-8" }));

  try {
    const image = new Image();
    image.decoding = "async";
    const loaded = new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error(messages.imageLoadError));
    });
    image.src = source;
    await loaded;

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error(messages.canvasUnavailable);
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error(messages.createError);
    return blob;
  } finally {
    URL.revokeObjectURL(source);
  }
}
