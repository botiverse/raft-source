// Ottie's face as the rail's Assistant destination: option A of the rail icon
// study (Artea, 2026-11-11), the curious art cropped into a round cream disc.

import ottieRail1x from "./otter/rail/ottie-rail@1x.webp";
import ottieRail2x from "./otter/rail/ottie-rail@2x.webp";
import ottieRail3x from "./otter/rail/ottie-rail@3x.webp";

const SRC_SET = `${ottieRail1x} 1x, ${ottieRail2x} 2x, ${ottieRail3x} 3x`;

/**
 * A round avatar of Ottie (28px on the rail, 24px on the phone Home's
 * Assistant row), in full colour on every rail surface and in
 * either selected sticker (it does not take the item's text colour). The disc
 * wears the avatar's 1.5px ink edge and, in dark mode, the die-cut edge
 * (Raft DS › Avatar). It is round and 28px rather than the DS Avatar's sticker
 * shape at 27px on purpose: this is the face Artea picked from the rail study
 * (option A), a character in the rail, not a person's avatar in a list. The
 * image is decorative: the rail item carries the name.
 *
 * The crops (otter/rail) are 28/56/84px squares with the cream (#fff3dc)
 * baked in, laid on the whole 28px box so each density draws pixel for pixel;
 * the edge covers the outer 1.5px. Each is the square (6,-14)-(154,134) of
 * otter/curious.webp (the repo's largest copy of this face) moved down 1/28,
 * Lanczos-scaled, with a light unsharp mask (radius 0.5-0.8, 30-45%).
 */
export function OttieRailAvatar({ size = 28 }: { size?: 24 | 28 } = {}) {
  // 24px is the phone Home's Assistant row (Artea, 2026-11-12, #triage:#350):
  // the same face where an entry's 20px glyph sits, a little larger so the
  // face still reads; the 28px crops scale down cleanly.
  const box = size === 24 ? "size-6" : "size-7";
  return (
    <span
      data-testid="ottie-rail-avatar"
      className={`relative block ${box} shrink-0 overflow-hidden rounded-full border-[1.5px] border-sticker-ink shadow-[0_0_0_1.5px_var(--sticker-edge)]`}
    >
      <img
        src={ottieRail1x}
        srcSet={SRC_SET}
        width={size}
        height={size}
        alt=""
        decoding="async"
        draggable={false}
        className={`pointer-events-none absolute -top-[1.5px] -left-[1.5px] ${box} max-w-none select-none`}
      />
    </span>
  );
}
