import { TextLink, TextLinkExternalIcon } from "@botiverse/raft-ui";
import type { ReactNode } from "react";
import { useMemo } from "react";
import { useIntl } from "react-intl";
import { opensInNewTabAriaLabel } from "../ui/LeavingRaftMark";
import { parseRuntimeFormV2Hint } from "./runtimeFormV2Hint";

/** A v2 hint with its inline https Markdown links as external links (runtimeFormV2Hint). */
export function RuntimeFormV2HintText({ hint }: { hint: string }): ReactNode {
  const { formatMessage } = useIntl();
  const opensInNewTab = formatMessage({ id: "common.opensInNewTab" });
  const parts = useMemo(() => parseRuntimeFormV2Hint(hint), [hint]);
  if (!parts.some((part) => "href" in part)) return hint;
  return parts.map((part) => ("href" in part ? (
    <TextLink key={part.at} render={<a href={part.href} target="_blank" rel="noopener noreferrer" aria-label={opensInNewTabAriaLabel(formatMessage, part.text)} />} variant="strong">
      {part.text}
      <TextLinkExternalIcon label={opensInNewTab} />
    </TextLink>
  ) : part.text));
}
