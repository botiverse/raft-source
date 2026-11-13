import { defaultSchema } from "rehype-sanitize";
import type { Options as RehypeSanitizeOptions } from "rehype-sanitize";
import { EXTERNAL_LINK_SCHEMES } from "@botiverse/raft-shared";

export const ORDERED_LIST_MARKDOWN_ATTRIBUTES = [
  ...(defaultSchema.attributes?.ol || []),
  "start",
];

// Link href schemes allowed in rendered markdown: the shared external-link
// allowlist (packages/shared externalLinkSchemes.ts), which Raft Desktop's
// shell also uses to decide what it hands to the OS. Shared by the
// message-body schema in `message/messageMarkdownSecurity.ts` so both sanitize
// layers agree.
export const MARKDOWN_HREF_PROTOCOLS = [...EXTERNAL_LINK_SCHEMES];

// The allowed schemes beyond rehype-sanitize's defaults (obsidian, task #734):
// react-markdown's default urlTransform would strip them again.
export const MARKDOWN_EXTRA_HREF_PROTOCOLS = MARKDOWN_HREF_PROTOCOLS.filter(
  (scheme) => !(defaultSchema.protocols?.href || []).includes(scheme),
);

export const markdownSanitizeSchema: RehypeSanitizeOptions = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    ol: ORDERED_LIST_MARKDOWN_ATTRIBUTES,
  },
  protocols: {
    ...defaultSchema.protocols,
    href: MARKDOWN_HREF_PROTOCOLS,
  },
};
