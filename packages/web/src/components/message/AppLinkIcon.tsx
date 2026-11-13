import { useState } from "react";
import { AppWindow } from "lucide-react";
import { AppLinkCardIcon, MessageReferenceIcon } from "@botiverse/raft-ui/wip";
import type { AppLinkApp } from "./useAppLinkPreviews";

/**
 * The App's icon Raft stores, never an image from the answer: the chip's
 * leading mark (`chip`) or the block card header's (`card`). The generic app
 * glyph without one, or when it fails to load.
 */
export function AppLinkIcon({ app, frame }: { app: AppLinkApp; frame: "chip" | "card" }) {
  const [broken, setBroken] = useState<string | null>(null);
  const icon = app.icon && app.icon !== broken ? app.icon : null;
  const image = icon ? <img src={icon} alt="" onError={() => setBroken(icon)} /> : <AppWindow aria-hidden />;
  if (frame === "card") return <AppLinkCardIcon>{image}</AppLinkCardIcon>;
  return icon ? <MessageReferenceIcon>{image}</MessageReferenceIcon> : image;
}
