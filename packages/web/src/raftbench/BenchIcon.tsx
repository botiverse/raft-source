import type { SVGProps } from "react";

// Lucide has no bench glyph; this follows its 24px grid, 2px round stroke and currentColor so it sits beside lucide icons.
export function BenchIcon(props: SVGProps<SVGSVGElement>) {
  return <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="lucide" {...props}>
    <rect x="3" y="7" width="18" height="3.5" rx="1" />
    <path d="M6.5 10.5 5.5 19" />
    <path d="M17.5 10.5 18.5 19" />
    <path d="M6 15h12" />
  </svg>;
}
