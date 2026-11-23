import { Fragment } from "react";
import { MessageItemSearchMatch } from "@botiverse/raft-ui";

import { searchParts } from "./artifactCommentSearch";

/**
 * A plain text (a name, a comment's one line, a mention) with the words searched for marked: raft-ui's
 * MessageItemSearchMatch, as a comment's Markdown and a message's text mark them. Text nodes only,
 * never markup from the query. The text alone without words to mark.
 */
export function ArtifactSearchMarks({ text, terms }: { text: string; terms: readonly string[] }) {
  if (terms.length === 0) return <>{text}</>;
  return (
    <>
      {searchParts(text, terms).map((part) => (part.hit ? (
        <MessageItemSearchMatch key={part.at} data-testid="artifact-comment-search-mark">{part.text}</MessageItemSearchMatch>
      ) : (
        <Fragment key={part.at}>{part.text}</Fragment>
      )))}
    </>
  );
}
