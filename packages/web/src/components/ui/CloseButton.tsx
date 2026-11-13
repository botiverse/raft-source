import { X } from "lucide-react";
import { Button } from "@botiverse/raft-ui";
import type { ButtonProps } from "@botiverse/raft-ui";
import { useIntl } from "react-intl";
import { BAR_BUTTON_DESKTOP } from "./headEdges";

/** Dismissal is a quiet icon action; the primary action owns the filled button.
 *  Raft Design System › IconButton: a borderless ink glyph whose hover/press is
 *  the pressed wash — the raft-ui ghost recipe draws exactly that, so only
 *  layout classes travel through `className`. With a mouse on a desktop the
 *  32px × is a 28px bar button (r6), as raft-ui's DialogClose and a head's
 *  actions (stdrc, 2026-11-04); pull it to a margin with ICON_BAR_END_PULL. */
export default function CloseButton({ children, className = "", size, ...props }: ButtonProps) {
  const { formatMessage } = useIntl();
  return (
    <Button
      type="button"
      variant="ghost"
      size={size ?? "icon-md"}
      aria-label={formatMessage({ id: "common.close" })}
      {...props}
      className={size === undefined || size === "icon-md" ? `${BAR_BUTTON_DESKTOP} ${className}` : className}
    >
      {children ?? <X size={16} />}
    </Button>
  );
}
