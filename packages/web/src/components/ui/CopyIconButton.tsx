import { Check, Copy } from "lucide-react";
import type { ButtonHTMLAttributes } from "react";
import { Button } from "@botiverse/raft-ui";
import Tooltip from "./Tooltip";

type CopyIconButtonSurface = "dark" | "light" | "code";

interface CopyIconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  copied: boolean;
  copiedLabel: string;
  copyLabel: string;
  surface?: CopyIconButtonSurface;
}

// Raft Design System › Code: the copy control is a quiet icon button (raft-ui
// ghost `icon-md`: 32px, an 18px glyph, a 44px hit area); after a copy its
// glyph swaps to a check for a few seconds — the swap is the signal, no colour
// change. `code` follows the code palette (index.css .r-code-copy);
// `dark` sits on the dark HUD-style surfaces; `light` on paper/surface.
const surfaceClasses: Record<CopyIconButtonSurface, { copied: string; idle: string }> = {
  code: {
    copied: "r-code-copy r-code-copy--copied hover:bg-transparent active:bg-transparent",
    idle: "r-code-copy hover:bg-transparent active:bg-transparent",
  },
  dark: {
    copied: "text-foreground-on-hud hover:bg-transparent active:bg-transparent",
    idle: "text-foreground-on-hud/0 group-hover:text-foreground-on-hud/70 hover:!text-foreground-on-hud hover:bg-transparent active:bg-transparent [@media(hover:none)]:text-foreground-on-hud/70",
  },
  light: {
    copied: "text-foreground",
    idle: "text-foreground-hint hover:text-foreground",
  },
};

export default function CopyIconButton({
  copied,
  copiedLabel,
  copyLabel,
  surface = "light",
  className = "",
  type = "button",
  ...props
}: CopyIconButtonProps) {
  const toneClass = copied ? surfaceClasses[surface].copied : surfaceClasses[surface].idle;

  return (
    <Tooltip content={copied ? copiedLabel : copyLabel}>
      <Button
        type={type}
        variant="ghost"
        size="icon-md"
        className={`${toneClass} ${className}`}
        aria-label={copied ? copiedLabel : copyLabel}
        {...props}
      >
        {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
      </Button>
    </Tooltip>
  );
}
