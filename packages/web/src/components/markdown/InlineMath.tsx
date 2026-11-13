import type { ReactNode } from "react";
import { InlineCode } from "@botiverse/raft-ui";
import { textOf, useRenderedFormula } from "./mathFormula";

/** An inline formula (`$…$`, or `$$…$$` within a line), task #775. */
export function InlineMath({ children }: { children?: ReactNode }) {
  const source = textOf(children);
  const html = useRenderedFormula(source, false);
  if (html === null) {
    return <InlineCode appearance="message" data-math-source="">{source}</InlineCode>;
  }
  return (
    <span
      className="raft-math-inline"
      data-math=""
      title={source}
      // KaTeX output with `trust: false`: markup KaTeX builds from the TeX,
      // never HTML from the message.
      // oxlint-disable-next-line react-doctor/no-danger -- KaTeX output (mathFormula.renderFormula, trust: false): markup KaTeX builds from the TeX, never HTML from the message; a ParseError renders the source as escaped text, any other error leaves the formula as plain code
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

