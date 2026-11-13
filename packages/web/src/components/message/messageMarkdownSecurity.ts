import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import remarkCjkFriendly from "remark-cjk-friendly";
import type { Options } from "react-markdown";
import { remarkAutolinkBareUrls } from "../../utils/markdownAutolink";
import { remarkRawHtmlAsText } from "./remarkMessageTokens";
import { remarkRaftMath } from "../markdown/remarkRaftMath";

type PluggableList = NonNullable<Options["remarkPlugins"]>;
type Pluggable = PluggableList[number];
import type { Options as RehypeSanitizeOptions } from "rehype-sanitize";
import { ORDERED_LIST_MARKDOWN_ATTRIBUTES, MARKDOWN_HREF_PROTOCOLS } from "../markdown/markdownSanitizeSchema";

// Internal building block of `messageMarkdownSanitizeSchema` (its `tagNames`
// allowlist). Not part of the module's public surface — the exported, tested
// schema is the security boundary; external code should consume that, not the
// raw tag list. (react-doctor unused-export: de-exported, not deleted — this
// is a live XSS allowlist, just internal.)
const MESSAGE_MARKDOWN_ALLOWED_TAGS = [
  "a",
  "blockquote",
  "br",
  "code",
  "del",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "img",
  "input",
  "li",
  "mark",
  "ol",
  "p",
  "pre",
  "s",
  "span",
  "strong",
  "sub",
  "sup",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
];

const MESSAGE_MARKDOWN_GLOBAL_ATTRIBUTES = [
  "ariaDescribedBy",
  "ariaLabel",
  "ariaLabelledBy",
  "alt",
  "height",
  "title",
  "width",
];

// Message token nodes (@mentions, #channels, task refs, thread refs) render as
// these anchors/spans with data-* attributes. Do not allow arbitrary
// GitHub-style raw HTML elements; user-typed HTML is shown as text anyway.
export const messageMarkdownSanitizeSchema: RehypeSanitizeOptions = {
  ...defaultSchema,
  tagNames: MESSAGE_MARKDOWN_ALLOWED_TAGS,
  attributes: {
    "*": MESSAGE_MARKDOWN_GLOBAL_ATTRIBUTES,
    a: [
      ...(defaultSchema.attributes?.a || []),
      "dataMention", "dataMentionType", "dataMentionId",
      "dataChannel",
      "dataTaskRef",
      "dataThreadRef", "dataThreadParent", "dataThreadParentName", "dataThreadParentType",
      "dataRaftRefKind", "dataRaftRefTarget",
    ],
    code: [
      ...(defaultSchema.attributes?.code || []),
    ],
    img: [
      ...(defaultSchema.attributes?.img || []),
    ],
    input: [
      ...(defaultSchema.attributes?.input || []),
      // `remark-gfm` generates this boolean for checked task-list items. Keep
      // it input-scoped: user-authored raw HTML is shown as text, never parsed,
      // while the existing input rules still constrain `disabled` and `type`.
      ["checked", true],
    ],
    ol: ORDERED_LIST_MARKDOWN_ATTRIBUTES,
    span: [
      ...(defaultSchema.attributes?.span || []),
      "dataReminderFireAt",
      // A caller's structured part (messageMarkdownSlots): an index into its own parts.
      "dataMessageSlot",
    ],
  },
  protocols: {
    ...defaultSchema.protocols,
    href: MARKDOWN_HREF_PROTOCOLS,
  },
};

// The message pipeline (task #762). User-typed raw HTML becomes the text the
// user typed (remarkRawHtmlAsText), so there is no `rehype-raw`: every element
// in a message comes from markdown syntax or from a message token node, and
// the sanitize schema above is the one allowlist they all pass.
export const MESSAGE_MARKDOWN_REHYPE_PLUGINS: PluggableList = [[rehypeSanitize, messageMarkdownSanitizeSchema]];

// remark-cjk-friendly: `**` next to CJK punctuation opens and closes emphasis
// (`中文**“重点”**中文`), which strict CommonMark refuses when the `**` sits
// between a CJK letter and punctuation; mobile ports the same rules.
const MESSAGE_MARKDOWN_BASE_REMARK_PLUGINS: PluggableList = [
  remarkGfm,
  remarkCjkFriendly,
  // Same math syntax as raft-shared's markdownStructure (task #775).
  remarkRaftMath,
  remarkAutolinkBareUrls,
  remarkRawHtmlAsText,
  remarkBreaks,
];

/**
 * remark plugins for a message body. `refsPlugin` (MessageItem's ref
 * matchers) runs before remark-breaks, which splits text at newlines and
 * drops the source positions the escape check and the blockquote repair read.
 */
export function messageMarkdownRemarkPlugins(refsPlugin?: Pluggable): PluggableList {
  if (!refsPlugin) return MESSAGE_MARKDOWN_BASE_REMARK_PLUGINS;
  // The base list with the ref matchers inserted before remark-breaks, so the
  // two lists can't drift apart.
  const breaksIndex = MESSAGE_MARKDOWN_BASE_REMARK_PLUGINS.indexOf(remarkBreaks);
  return [
    ...MESSAGE_MARKDOWN_BASE_REMARK_PLUGINS.slice(0, breaksIndex),
    refsPlugin,
    ...MESSAGE_MARKDOWN_BASE_REMARK_PLUGINS.slice(breaksIndex),
  ];
}
