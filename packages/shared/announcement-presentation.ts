export interface AnnouncementPresentation {
  /** Omitted legacy announcements keep the centered modal. */
  displayMode?: "modal" | "sidebar";
  label?: string;
  cta?: { label: string; href: string };
  image?: { assetId: string; alt: string };
}

export interface AnnouncementContent extends AnnouncementPresentation {
  title: string;
  pages: Array<{ title?: string; body: string }>;
}

/** Validates optional publisher fields without retaining arbitrary executable data. */
export function validateAnnouncementPresentation(value: unknown): AnnouncementPresentation {
  if (!value || typeof value !== "object") return {};
  const raw = value as Record<string, unknown>;
  const result: AnnouncementPresentation = {};
  if (raw.displayMode !== undefined) {
    if (raw.displayMode !== "modal" && raw.displayMode !== "sidebar") throw new Error("invalid announcement display mode");
    result.displayMode = raw.displayMode;
  }
  if (raw.label !== undefined) {
    if (typeof raw.label !== "string" || raw.label.length > 100) throw new Error("announcement label must contain at most 100 characters");
    if (raw.label.trim()) result.label = raw.label.trim();
  }
  if (raw.cta !== undefined) {
    const cta = raw.cta as Record<string, unknown>;
    if (!cta || typeof cta !== "object" || typeof cta.label !== "string" || !cta.label.trim() || cta.label.length > 100 || typeof cta.href !== "string" || cta.href.length > 2048) throw new Error("invalid announcement CTA");
    if (/[\u0000-\u001f]/.test(cta.href)) throw new Error("invalid announcement CTA characters");
    const href = cta.href.trim();
    const internal = (href.startsWith("/") || href.startsWith("?")) && !href.startsWith("//") && !href.includes("\\") && !/[\u0000-\u0020]/.test(href);
    let external = false;
    try { const url = new URL(href); external = url.protocol === "https:" && !url.username && !url.password; } catch { /* relative link */ }
    if (!internal && !external) throw new Error("announcement CTA must be an internal path or HTTPS URL");
    result.cta = { label: cta.label.trim(), href };
  }
  if (raw.image !== undefined) {
    const image = raw.image as Record<string, unknown>;
    if (!image || typeof image !== "object" || typeof image.assetId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(image.assetId) || typeof image.alt !== "string" || image.alt.length > 500) throw new Error("invalid announcement image");
    result.image = { assetId: image.assetId, alt: image.alt };
  }
  return result;
}
