import type { HTMLAttributes } from "react";

type SidebarSectionDescriptionProps = HTMLAttributes<HTMLDivElement> & {
  tone?: "muted" | "subtle" | "strong";
};

/**
 * Compact help and empty-state copy that belongs to a Sidebar section.
 *
 * Keep this separate from entity metadata (for example an agent description)
 * and from the full-panel EmptyState primitive. Section descriptions share one
 * typography contract while their callsites retain context-specific spacing.
 */
export function SidebarSectionDescription({
  children,
  className = "",
  tone = "muted",
  ...props
}: SidebarSectionDescriptionProps) {
  return (
    <div
      {...props}
      data-sidebar-section-description=""
      className={`px-5 md:pointer-fine:pr-(--page-inset) md:pointer-fine:pl-(--sidebar-text-axis) font-sans text-footnote ${tone === "strong" ? "text-foreground" : tone === "subtle" ? "text-foreground-hint" : "text-foreground-muted"} ${className}`}
    >
      {children}
    </div>
  );
}
