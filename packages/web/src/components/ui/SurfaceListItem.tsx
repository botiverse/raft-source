import type { HTMLAttributes, ReactNode } from "react";

export default function SurfaceListItem({
  children,
  selected = false,
  interactive = true,
  className = "",
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  children: ReactNode;
  selected?: boolean;
  interactive?: boolean;
}) {
  return (
    <div
      className={[
        "border-2 px-4 py-3 transition-colors",
        selected
          ? "border-black bg-brutal-cyan/15 shadow-brutal-sm"
          : [
              "border-black/30 bg-white",
              interactive ? "hover:border-black hover:shadow-brutal-sm" : "",
            ].join(" "),
        className,
      ].join(" ")}
      {...props}
    >
      {children}
    </div>
  );
}
