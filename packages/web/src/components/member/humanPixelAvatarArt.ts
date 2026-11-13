import { useEffect, useState } from "react";
import { readHumanAvatarRecipe, renderHumanAvatarSvg, serializeHumanAvatarRecipe } from "@botiverse/raft-shared/src/humanAvatar";
import type { HumanAvatarArt } from "@botiverse/raft-shared/src/humanAvatar";

// A person's built pixel avatar (`pixel-human:v1:...`, shared humanAvatar.ts):
// the shared renderer's SVG, the same one the Server sends to surfaces that
// need an image URL. The art (~250 KB, 3.5 KB gzipped) loads on the first one
// drawn, never in the startup bundle; until then the frame shows its own fill.

let loadedArt: HumanAvatarArt | null = null;
let artPromise: Promise<HumanAvatarArt> | null = null;

/** Loads the art once; a failed load (an old chunk after a deploy) may be retried. */
export function loadHumanAvatarArt(): Promise<HumanAvatarArt> {
  artPromise ??= import("@botiverse/raft-shared/src/humanAvatarArt").then(
    (module) => (loadedArt = module.HUMAN_AVATAR_ART),
    (error: unknown) => {
      artPromise = null;
      throw error;
    },
  );
  return artPromise;
}

type ArtState = { art: HumanAvatarArt | null; failed: boolean };

/** The art, once loaded; `failed` when it could not be (the caller falls back). */
export function useHumanAvatarArt(): ArtState {
  const [state, setState] = useState<ArtState>({ art: loadedArt, failed: false });
  useEffect(() => {
    if (state.art) return;
    let live = true;
    loadHumanAvatarArt().then(
      (art) => { if (live) setState({ art, failed: false }); },
      () => { if (live) setState({ art: null, failed: true }); },
    );
    return () => { live = false; };
  }, [state.art]);
  return state;
}

// One image per look, kept for the page's life: a look's pixels never change.
// An object URL where the browser has one (a few hundred bytes of string per
// avatar instead of a ~60 KB data URL), else a data URL.
const srcCache = new Map<string, string>();

export function humanAvatarImageSrc(avatarUrl: string, art: HumanAvatarArt): string | null {
  const recipe = readHumanAvatarRecipe(avatarUrl);
  if (!recipe) return null;
  const key = serializeHumanAvatarRecipe(recipe);
  const cached = srcCache.get(key);
  if (cached) return cached;
  const svg = renderHumanAvatarSvg(recipe, art);
  const src = typeof URL.createObjectURL === "function" && typeof Blob === "function"
    ? URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }))
    : `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  srcCache.set(key, src);
  return src;
}
