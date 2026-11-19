import { defineCatalog } from "@json-render/core";
import { ActionProvider, defineRegistry, Renderer, StateProvider, VisibilityProvider } from "@json-render/react";
import { schema } from "@json-render/react/schema";
import { Badge, Text } from "@botiverse/raft-ui";
import { previewBadgeProps, previewStackProps, previewTextProps } from "@botiverse/raft-shared/src/appLinkPreview";
import type { AppLinkPreviewContent } from "@botiverse/raft-shared/src/appLinkPreview";

// The v1 card's read-only catalog, painted with raft-ui inside the hover card.
// The App's state is a neutral soft Badge, in its own words (PreviewCard ›
// Item card rules). v1 has no buttons; v2's go in PreviewCardActions
// (LinkCardActions.tsx).
const emptyState = Object.freeze({});
const noActions = Object.freeze({});
const catalog = defineCatalog(schema, {
  components: {
    Stack: { props: previewStackProps, slots: ["default"] },
    Text: { props: previewTextProps },
    Badge: { props: previewBadgeProps },
  },
  actions: {},
});
const { registry } = defineRegistry(catalog, { actions: {}, components: {
  Stack: ({ children }) => <div className="flex min-w-0 flex-col gap-1.5">{children}</div>,
  Text: ({ props }) => <Text.Sans size="small" variant={props.tone === "muted" ? "muted" : "default"} className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{props.text}</Text.Sans>,
  Badge: ({ props }) => <Badge appearance="soft" className="max-w-full self-start whitespace-normal break-words">{props.text}</Badge>,
} });

/** A v1 App link card's body, rendered from the App's json-render spec. */
export function AppLinkCardV1Body({ spec }: { spec: NonNullable<AppLinkPreviewContent["card"]> }) {
  return (
    <StateProvider initialState={emptyState}><VisibilityProvider><ActionProvider handlers={noActions}>
      <Renderer spec={spec} registry={registry} />
    </ActionProvider></VisibilityProvider></StateProvider>
  );
}
