import art from "../assets/humanAvatarLayers.json" with { type: "json" };
import type { HumanAvatarArt } from "./humanAvatar";

// The human pixel-avatar art (Oscar, v3.3), separate from humanAvatar.ts so the
// web loads its ~250 KB (3.5 KB gzipped) only when a built avatar is first drawn.
export const HUMAN_AVATAR_ART: HumanAvatarArt = art;

/**
 * The art's revision (Oscar's export version). Image URLs of a built avatar
 * carry it (`?art=`), because the Server's SVG is cached immutable for a year:
 * when an option's pixels change (v3.2: the headphones; v3.3: long hair), the
 * URL changes with them, while the stored recipes stay as they are.
 */
export const HUMAN_AVATAR_ART_REVISION: string = art.artVersion;
