import type { ComponentPropsWithoutRef, CSSProperties } from "react";

type RootFallbackScrollerProps = Omit<
  ComponentPropsWithoutRef<"div">,
  "style"
> & {
  style?: CSSProperties;
};

export default function RootFallbackScroller({
  style,
  ...props
}: RootFallbackScrollerProps) {
  return (
    <div
      {...props}
      data-root-fallback-scroller=""
      style={{
        ...style,
        width: "100%",
        height: "100%",
        minHeight: 0,
        flex: "1 1 auto",
        boxSizing: "border-box",
        overflowX: "hidden",
        // raft-ui: native-scroll the root crash and update screens must scroll without the stylesheet or raft-ui loaded (slock PR 5116); permanent, not ScrollArea debt
        overflowY: "auto",
        overscrollBehaviorY: "contain",
        WebkitOverflowScrolling: "touch",
      }}
    />
  );
}
