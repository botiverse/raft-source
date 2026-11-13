import type { ReactNode } from "react";
import SectionEyebrow from "../../../components/ui/SectionEyebrow";

export function ConnectedAppDetailSection({
  title,
  description,
  children,
  tone = "white",
}: {
  title: string;
  description?: string;
  children: ReactNode;
  tone?: "white" | "cream";
}) {
  return (
    <section className={`rounded-container border border-line-hairline p-4 ${tone === "cream" ? "bg-fill-muted" : "bg-layer-card"}`}>
      <SectionEyebrow as="div">{title}</SectionEyebrow>
      {description && <div className="mt-1 text-footnote text-foreground-muted">{description}</div>}
      <div className="mt-3">{children}</div>
    </section>
  );
}
