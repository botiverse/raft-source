/**
 * A base64 `data:` URL's bytes as a Blob, decoded in place: no `fetch`.
 * Raft Desktop's page policy allows `connect-src 'self' app: https: wss:`, not
 * `data:`, so `fetch(dataUrl)` is refused there and a generated image read that
 * way came out as nothing ("the generated image is empty", #triage:#352).
 * Throws on anything that isn't a base64 data URL.
 */
export function dataUrlToBlob(dataUrl: string): Blob {
  const match = /^data:([^;,]*)(?:;[^,]*)?;base64,(.*)$/s.exec(dataUrl);
  if (!match) throw new Error("not a base64 data URL");
  const binary = atob(match[2]!);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: match[1] || "application/octet-stream" });
}
