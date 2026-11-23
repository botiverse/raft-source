// Platform entry point: what first-party objects name in their content
// (`object_references`, #proj-workspace:#336). An app reads its object's
// latest content outside any transaction, then replaces all of that source's
// references in one short transaction of its own (replaceReferences), reads
// them back in order (referencesOfSource), and deletes them with the source
// (deleteReferencesOfSource). The table, its kinds' check against the
// registry and its closed-server purge are core's, and so are core's own
// sources (CORE_SOURCE_KINDS: a chat message's links, services/messageReferences.ts).
//
// What names an object ("Linked from", #336 step 2), read where the reader's
// visibility is checked in the same statement: `sourcesReferencingSql`, the
// ids of one kind's sources that name an object, a subquery an app puts
// beside its own visibility condition (an Artifact's other Artifacts:
// apps/artifacts/backlinks.ts); and `messageBacklinks`, the chat messages that
// name it as a viewer reads them (core's rules for messages: visible
// conversations, the history window, live messages; services/messageBacklinks.ts).
export { messageBacklinks, MESSAGE_BACKLINK_EXCERPT_CHARS, type MessageBacklink, type MessageBacklinks } from "../services/messageBacklinks";
export {
  deleteReferencesOfSource,
  OBJECT_REFERENCES_MAX_PER_SOURCE,
  ObjectReferenceRejected,
  referencesOfSource,
  replaceReferences,
  sourcesReferencingSql,
  type ObjectReference,
  type ObjectReferenceDetail,
  type ObjectReferenceSource,
} from "../services/objectReferences";
