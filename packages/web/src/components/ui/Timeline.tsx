import type { ReactNode } from "react";

export type TimelineItem = { id: string; title: ReactNode; meta?: ReactNode; children?: ReactNode; colorClass?: string; lineColorClass?: string };

export default function Timeline({ items }: { items: TimelineItem[] }) {
  return <ol className="space-y-0" data-testid="timeline">
    {items.map((item, index) => <li key={item.id} className="relative flex gap-3 pb-4 last:pb-0">
      {index < items.length - 1 && <span className={`absolute left-[5px] top-3 h-full w-px ${item.lineColorClass ?? item.colorClass ?? items[index - 1]?.colorClass ?? "bg-black/20"}`} aria-hidden="true" />}
      <span className={`relative mt-1.5 h-3 w-3 shrink-0 rounded-full border-2 ${item.colorClass === "bg-brutal-orange" ? "border-brutal-orange/60" : item.colorClass === "bg-brutal-cyan" ? "border-brutal-cyan/60" : item.colorClass === "bg-brutal-lavender" ? "border-brutal-lavender/60" : item.colorClass === "bg-brutal-lime" ? "border-brutal-lime/60" : item.colorClass === "bg-brutal-stone" ? "border-brutal-stone/60" : "border-black/20"} ${item.colorClass ?? "bg-white"}`} aria-hidden="true" />
      <div className="min-w-0 flex-1 text-xs"><div className="font-bold">{item.title}</div>{item.meta && <div className="text-black/50">{item.meta}</div>}{item.children}</div>
    </li>)}
  </ol>;
}
