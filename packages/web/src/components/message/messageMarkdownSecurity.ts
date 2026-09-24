import { defaultSchema } from "rehype-sanitize";
import type { Options as RehypeSanitizeOptions } from "rehype-sanitize";
import { ORDERED_LIST_MARKDOWN_ATTRIBUTES } from "../markdown/markdownSanitizeSchema";

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

// Chat messages need rehypeRaw only for controlled anchors/spans that we inject
// after preprocessing (@mentions, #channels, task refs, reminders). Do not allow
// arbitrary GitHub-style raw HTML elements from user-authored message text.
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
      // it input-scoped: user-authored raw HTML is escaped before rehypeRaw,
      // while the existing input rules still constrain `disabled` and `type`.
      ["checked", true],
    ],
    ol: ORDERED_LIST_MARKDOWN_ATTRIBUTES,
    span: [
      ...(defaultSchema.attributes?.span || []),
      "dataReminderFireAt",
    ],
  },
};

const MARKDOWN_AUTOLINK_PATTERN =
  /<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*|[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})>/g;

export function escapeUserRawHtmlForMessageMarkdown(source: string): string {
  const autolinks: string[] = [];
  const protectedSource = source.replace(MARKDOWN_AUTOLINK_PATTERN, (match) => {
    const index = autolinks.length;
    autolinks.push(match);
    return `\x00AUTOLINK${index}\x00`;
  });

  return protectedSource
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    // oxlint-disable-next-line no-control-regex -- NUL (\u0000) is an intentional private sentinel around placeholder tokens; cannot appear in user markdown
    .replace(/\x00AUTOLINK(\d+)\x00/g, (_match, index) => autolinks[Number(index)] ?? "");
}
