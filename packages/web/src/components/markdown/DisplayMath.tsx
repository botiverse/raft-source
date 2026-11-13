import { ScrollArea } from "@botiverse/raft-ui";
import { useRenderedFormula } from "./mathFormula";

/** A block formula (`$$` on its own lines), task #775. */
export function DisplayMath({ source }: { source: string }) {
  const html = useRenderedFormula(source, true);
  if (html === null) {
    return (
      // raft-ui: native-scroll a <pre> holds phrasing content only
      <pre className="raft-math-display my-2 overflow-x-auto font-mono text-mono-code" data-math-source="">
        <code>{source}</code>
      </pre>
    );
  }
  // A wide formula scrolls sideways in a horizontal raft-ui ScrollArea, as raft-ui's
  // wide Markdown tables do; KaTeX's markup goes in an element of its own inside
  // it, since the area's first child is its scrollbars.
  return (
    <ScrollArea orientation="horizontal" className="raft-math-display my-2" data-math="">
      <div
        // oxlint-disable-next-line react-doctor/no-danger -- KaTeX output (mathFormula.renderFormula, trust: false): markup KaTeX builds from the TeX, never HTML from the message; a ParseError renders the source as escaped text, any other error leaves the formula as plain code
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </ScrollArea>
  );
}
