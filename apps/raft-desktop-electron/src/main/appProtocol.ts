import { readFile } from "node:fs/promises";
import path from "node:path";

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
  ".jpg": "image/jpeg", ".woff2": "font/woff2", ".woff": "font/woff",
  ".map": "application/json", ".ttf": "font/ttf",
};

export function createAppProtocolHandler(root: string, read = readFile) {
  return async (request: Request): Promise<Response> => {
    let pathname: string;
    try {
      const url = new URL(request.url);
      if (url.host !== "raft") return new Response("forbidden", { status: 403 });
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return new Response("bad request", { status: 400 });
    }
    const relative = pathname.replace(/^\/+/, "") || "index.html";
    const resolved = path.resolve(root, relative);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      return new Response("forbidden", { status: 403 });
    }
    let filePath = resolved;
    try {
      let data: Buffer;
      try {
        data = await read(filePath);
      } catch (error) {
        const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
        // Asset failures must not masquerade as successful SPA HTML.
        const staticPath = /^\/(assets|brand|fonts)(\/|$)/.test(pathname);
        const navigation = request.mode === "navigate"
          || request.headers.get("accept")?.includes("text/html")
          || path.extname(pathname) === "";
        if (!missing || staticPath || !navigation) throw error;
        filePath = path.join(root, "index.html");
        data = await read(filePath);
      }
      const hashedAsset = /^assets\/[^/]+-[A-Za-z0-9_-]{8,}\.[^.]+$/.test(path.relative(root, filePath));
      return new Response(new Uint8Array(data), {
        headers: {
          "content-type": CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream",
          // Only content-addressed build output can outlive an app upgrade.
          "cache-control": hashedAsset ? "public, max-age=31536000, immutable" : "no-cache",
        },
      });
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
      return new Response(missing ? "not found" : "resource read failed", { status: missing ? 404 : 500 });
    }
  };
}
