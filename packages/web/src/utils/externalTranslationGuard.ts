export const EXTERNAL_TRANSLATION_GUARD_CLASS = "notranslate";
export const EXTERNAL_TRANSLATION_GUARD_TRANSLATE = "no" as const;

export function withExternalTranslationGuardClass(className?: string): string {
  return [className, EXTERNAL_TRANSLATION_GUARD_CLASS].filter(Boolean).join(" ");
}

function markNotExternallyTranslatable(element: Element | null | undefined): void {
  if (!element) return;
  element.setAttribute("translate", EXTERNAL_TRANSLATION_GUARD_TRANSLATE);
  element.classList.add(EXTERNAL_TRANSLATION_GUARD_CLASS);
}

function ensureGoogleNotranslateMeta(doc: Document): void {
  const existing = doc.head.querySelector<HTMLMetaElement>('meta[name="google"]');
  if (existing) {
    existing.setAttribute("content", "notranslate");
    return;
  }

  const meta = doc.createElement("meta");
  meta.setAttribute("name", "google");
  meta.setAttribute("content", "notranslate");
  doc.head.appendChild(meta);
}

export function installExternalTranslationGuard(doc: Document | undefined = globalThis.document): void {
  if (!doc) return;

  ensureGoogleNotranslateMeta(doc);
  markNotExternallyTranslatable(doc.documentElement);
  markNotExternallyTranslatable(doc.body);
  markNotExternallyTranslatable(doc.getElementById("root"));
}
