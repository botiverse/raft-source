import { useCallback, useRef } from "react";
import { useIntl } from "react-intl";
import { EllipsisVertical } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  PanelAction,
  PanelActions,
} from "@botiverse/raft-ui";
import type { ArtifactId } from "@botiverse/raft-shared";

import LeavingRaftMark from "../../components/ui/LeavingRaftMark";
import Tooltip from "../../components/ui/Tooltip";
import { showToast } from "../../components/toastBridge";
import { copyTextToClipboard } from "../../utils/selectMarkdown";
import { useArtifactAskAi } from "./artifactAskAi";
import { useArtifactFind } from "./artifactFind";

/**
 * The public page's "for agents" actions (#proj-workspace:#101; the prompt,
 * the links and Copy for AI's feedback: useArtifactAskAi, the one copy). The
 * public page (PublicArtifactPage) exists only for a public Artifact (a
 * visitor, or a signed-in outsider reading it there). Only a signed-out
 * visitor is offered the three (`askAi`, xxchan): a signed-in reader, of the
 * Artifact's server or another, has their agents in Raft to ask, so neither
 * this page signed in nor the in-app viewer's ⋯ (ArtifactViewerMenu) has them.
 *
 * The header's ⋯ (a PanelAction: 32px on a desktop, 44px on a phone and a
 * touch screen) opens a menu named after the Artifact: Copy link first, then
 * the three, at every width.
 *
 * Send to conversation isn't here: it is the header's Fork in Raft, the
 * page's one labelled (pink) action, beside this ⋯ (PublicArtifactPage,
 * #proj-workspace:#140).
 *
 * `link`: Copy link, the menu's first item for every reader (xxchan): the page's public address, said in the
 * viewer's toast (Link copied.); nothing is reported (the page has no analytics identity).
 *
 * `reportLabel`, `reportHref`: Report Abuse, last and apart, for every reader (xxchan: in the
 * menu, not a footer of its own); signed in, it follows Copy link alone.
 *
 * `findInMenu`: Find in page after Copy link, apart, where the page may be searched (artifactFind), on a phone, where the
 * header has no room for its button (as the viewer's ⋯ holds it, ArtifactViewerMenu); it hands focus to the bar's
 * field, so closing, the menu doesn't take it back to ⋯.
 */
export default function PublicArtifactAiActions({ id, title, link, askAi, reportLabel, reportHref, findInMenu = false }: {
  id: ArtifactId;
  title: string;
  /** The public address Copy link copies (built from the address's id, never the payload). */
  link: string;
  /** Copy for AI, Open in ChatGPT and Open in Claude: only for a signed-out visitor. */
  askAi: boolean;
  /** Report Abuse: its label and its mailto: address. */
  reportLabel: string;
  reportHref: string;
  /** Find in page here (a phone), where it is offered. */
  findInMenu?: boolean;
}) {
  const { formatMessage } = useIntl();
  const { copyLabel, copy, asks } = useArtifactAskAi(id);
  const moreLabel = formatMessage({ id: "artifacts.viewer.more" });
  const find = useArtifactFind();
  const openBar = findInMenu && find?.offered ? find.openBar : null;
  const handsFocus = useRef(false);
  const openFind = useCallback(() => {
    handsFocus.current = true;
    openBar?.();
  }, [openBar]);
  const copyLink = useCallback(() => {
    void copyTextToClipboard(link, formatMessage).then(
      () => showToast({ title: formatMessage({ id: "artifacts.menu.linkCopied" }), type: "success" }),
      () => showToast({ title: formatMessage({ id: "artifacts.frame.copyFailed" }), type: "error" }),
    );
  }, [link, formatMessage]);
  const finalFocus = useCallback(() => {
    const toTrigger = !handsFocus.current;
    handsFocus.current = false;
    return toTrigger;
  }, []);

  return (
    <PanelActions>
      <DropdownMenu>
        <Tooltip content={moreLabel}>
          <DropdownMenuTrigger
            render={(
              <PanelAction aria-label={moreLabel} data-testid="public-artifact-ai-menu-trigger">
                <EllipsisVertical />
              </PanelAction>
            )}
          />
        </Tooltip>
        <DropdownMenuContent side="bottom" align="end" sideOffset={4} finalFocus={finalFocus} aria-label={title} data-testid="public-artifact-ai-menu">
          {/* No leading icons here: none of this menu's items has one, so the labels line up. */}
          <DropdownMenuItem onClick={copyLink} data-testid="public-artifact-menu-copy-link">
            {formatMessage({ id: "artifacts.menu.copyLink" })}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {openBar ? (
            <>
              <DropdownMenuItem onClick={openFind} data-testid="public-artifact-menu-find">
                {formatMessage({ id: "artifacts.find.open" })}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          ) : null}
          {askAi ? (
            <>
              <DropdownMenuItem onClick={copy} data-testid="public-artifact-ai-menu-copy">
                {copyLabel}
              </DropdownMenuItem>
              {asks.map((ask) => (
                <DropdownMenuItem
                  key={ask.key}
                  render={<a href={ask.href} target="_blank" rel="noopener noreferrer" aria-label={ask.ariaLabel} />}
                  data-testid={`public-artifact-ai-menu-${ask.key}`}
                >
                  {ask.label}
                  {/* ↗ where a shortcut goes, in the hint color (raft-design navigation.md "Links that leave Raft"). */}
                  <LeavingRaftMark className="ms-auto text-foreground-hint" />
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
            </>
          ) : null}
          <DropdownMenuItem render={<a href={reportHref} aria-label={reportLabel} />} data-testid="public-artifact-report">
            {reportLabel}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </PanelActions>
  );
}
