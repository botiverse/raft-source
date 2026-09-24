/**
 * Canonical section-eyebrow label — replaces the inline
 * `text-xs font-bold uppercase text-black/60 tracking-widest` pattern
 * that appears 40+ times across panels, dialogs, and list headers.
 *
 * stdrc 2026-05-11 #wg-theme:93c5897c assigned this to @Wug as the
 * next Tier 1 component after PanelHeader / AvatarSlot / AvatarListRow /
 * Banner. Per @Duoyu audit msg=cc6f5542 the eyebrow class string was the
 * single biggest repeated typographic pattern in the codebase.
 *
 * The component renders the locked typographic token and accepts:
 * - `as` — element type (`"span"` | `"div"` | `"label"`, default `"span"`)
 * - `className` — callsite-specific additions (margin, padding, bg, color)
 * - `htmlFor` — forwarded when `as="label"`
 * - `children` — label text
 *
 * Do NOT inline new section eyebrows — use this primitive instead.
 *
 * Default color is `text-black/60`. To get a fully-black eyebrow
 * (e.g. Sidebar section toggle, MachineDetailPanel running label),
 * pass `className="!text-black"` to override.
 */

import type { LabelHTMLAttributes, ReactNode } from "react";

const BASE_CLASS = "text-xs font-bold uppercase text-black/60 tracking-widest";

export type SectionEyebrowProps = {
  /** HTML element to render. Default `"span"`. Use `"div"` for block-level
   *  eyebrows (e.g. with `mb-3`), `"label"` for form field labels. */
  as?: "span" | "div" | "label";
  /** Additional classes — appended to the base token. Useful for margin
   *  (`mb-3`), padding (`px-3 py-1.5`), background (`bg-white/50`), or
   *  color overrides (`!text-black`). */
  className?: string;
  /** Eyebrow text / nodes. */
  children?: ReactNode;
  /** When `as="label"`, forward to the `<label htmlFor>` attribute. */
  htmlFor?: LabelHTMLAttributes<HTMLLabelElement>["htmlFor"];
  /** `false` renders the label in natural (source-string) case instead of
   *  the legacy all-caps token (Artea 2026-08-05: all-caps hurts
   *  readability). Default `true` keeps every existing callsite intact. */
  uppercase?: boolean;
};

export default function SectionEyebrow({
  as: Tag = "span",
  className = "",
  children,
  htmlFor,
  uppercase = true,
}: SectionEyebrowProps) {
  const cls = `${uppercase ? BASE_CLASS : BASE_CLASS.replace(" uppercase", "")} ${className}`.trim();
  if (Tag === "label") {
    return (
      <label className={cls} htmlFor={htmlFor}>
        {children}
      </label>
    );
  }
  if (Tag === "div") {
    return <div className={cls}>{children}</div>;
  }
  return <span className={cls}>{children}</span>;
}
