// The otter's pose on an edge (assistantOtterEdgeArt.ts), drawn inside the box of its visible part.

import type { EdgeArt } from "./assistantOtterEdgeArt";

/** The image, placed inside a box the size of edgeArtBox. */
export function EdgeArtImage({ art }: { art: EdgeArt }) {
  const [left, top, width, height] = art.css;
  return (
    <img
      src={art.src}
      width={width}
      height={height}
      alt=""
      draggable={false}
      className="pointer-events-none absolute max-w-none select-none"
      style={{ left: left - art.visible[0], top: top - art.visible[1], width, height }}
    />
  );
}

