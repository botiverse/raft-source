import { MERMAID_PALETTES } from "./mermaidTheme";
import type { MermaidRenderResult } from "./mermaidRenderer";
import { reportClientError } from "../../utils/clientErrorTrace";

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
    if (!context) {
      // Rare (a browser without a 2D canvas), so the user gets a plain error,
      // but it must be traceable (#proj-raft-ui:#245): the fixed site name
      // only, never the diagram or the localized message.
      reportClientError({ source: "mermaid_export", site: "mermaid.png_canvas_unavailable", error: new Error("canvas_unavailable") });
      throw new Error(messages.canvasUnavailable);
    }
    context.fillStyle = MERMAID_PALETTES[result.theme].background;
    context.fillRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error(messages.createError);
    return blob;
  } finally {
    URL.revokeObjectURL(source);
  }
}
