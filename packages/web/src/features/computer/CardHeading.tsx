import type { ComponentProps } from "react";

/** A card's title as its heading (Card: render CardTitle as the heading the page needs). */
export function CardHeading({ children, ...props }: ComponentProps<"h3">) {
  return <h3 {...props}>{children}</h3>;
}
