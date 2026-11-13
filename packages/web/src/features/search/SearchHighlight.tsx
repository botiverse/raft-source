import { Fragment, useMemo } from "react";
import { SearchMessageResultMatch } from "@botiverse/raft-ui";
import { splitSearchHighlight } from "./searchHighlightParts";

export function SearchHighlight({ text, query }: { text: string; query: string }) {
  const parts = useMemo(() => splitSearchHighlight(text, query), [text, query]);
  return (
    <>
      {parts.map((part, index) => (part.hit ? (
        <SearchMessageResultMatch key={`${part.text}-${index}`}>
          {part.text}
        </SearchMessageResultMatch>
      ) : (
        // A bare text node, not a <span>: accessible names keep the spacing.
        <Fragment key={`${part.text}-${index}`}>{part.text}</Fragment>
      )))}
    </>
  );
}
