import { defaultSchema } from "rehype-sanitize";
import type { Options as RehypeSanitizeOptions } from "rehype-sanitize";

export const ORDERED_LIST_MARKDOWN_ATTRIBUTES = [
  ...(defaultSchema.attributes?.ol || []),
  "start",
];

export const markdownSanitizeSchema: RehypeSanitizeOptions = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    ol: ORDERED_LIST_MARKDOWN_ATTRIBUTES,
  },
};
