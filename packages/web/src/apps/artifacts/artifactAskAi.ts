import { useCallback, useMemo } from "react";
import { useIntl } from "react-intl";
import type { ArtifactId } from "@botiverse/raft-shared";

import { showToast } from "../../components/toastBridge";
import { opensInNewTabAriaLabel } from "../../components/ui/LeavingRaftMark";
import { copyTextToClipboard } from "../../utils/selectMarkdown";
import { artifactUrl } from "./artifactLinks";

/**
 * The "for agents" actions (#proj-workspace:#101), after the website's For
 * agents block (raft-landing AgentSignpost): Copy for AI copies a prompt that
 * points an assistant at the Artifact's own link, the one people open
 * (xxchan: one link, not an API address). That page carries what a fetcher
 * reads: an article with the title, the files, the Markdown version and
 * index.md's text, and the Markdown itself to an Accept: text/markdown
 * request (public/_worker.js). Open in ChatGPT and Open in Claude start a
 * chat with it. The prompt is in the page's language.
 *
 * Offered only on the public page's ⋯ (PublicArtifactAiActions), to a reader
 * who isn't asking in Raft (xxchan): a signed-in reader, of the Artifact's
 * server or another, has their agents in Raft, so the in-app viewer's and
 * the standalone page's ⋯ (ArtifactViewerMenu) have none.
 */
export interface ArtifactAskAi {
  copyLabel: string;
  /** Copies the prompt (`artifacts.public.aiPrompt`, naming the Artifact's page link); the app's Copied toast, or Couldn't copy. */
  copy: () => Promise<void>;
  /** Open in ChatGPT, then Open in Claude: a new chat with the prompt typed in, in a new tab. */
  asks: ReadonlyArray<{ key: "chatgpt" | "claude"; label: string; href: string; ariaLabel: string }>;
}

export function useArtifactAskAi(id: ArtifactId): ArtifactAskAi {
  const { formatMessage } = useIntl();
  const prompt = formatMessage({ id: "artifacts.public.aiPrompt" }, { url: artifactUrl(id) });
  // The app's copy feedback: the Copied toast (as a framed page's copyText).
  const copy = useCallback(async () => {
    try {
      await copyTextToClipboard(prompt);
      showToast({ title: formatMessage({ id: "artifacts.frame.copied" }) });
    } catch {
      showToast({ title: formatMessage({ id: "artifacts.frame.copyFailed" }), type: "error" });
    }
  }, [formatMessage, prompt]);
  return useMemo(() => {
    const q = encodeURIComponent(prompt);
    const chatGpt = formatMessage({ id: "artifacts.public.openInChatGpt" });
    const claude = formatMessage({ id: "artifacts.public.openInClaude" });
    return {
      copyLabel: formatMessage({ id: "artifacts.public.copyForAi" }),
      copy,
      asks: [
        { key: "chatgpt", label: chatGpt, href: `https://chatgpt.com/?q=${q}`, ariaLabel: opensInNewTabAriaLabel(formatMessage, chatGpt) },
        { key: "claude", label: claude, href: `https://claude.ai/new?q=${q}`, ariaLabel: opensInNewTabAriaLabel(formatMessage, claude) },
      ],
    };
  }, [prompt, copy, formatMessage]);
}

