import type { operations } from "./generated/openapi";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2)
    ? true
    : false;
type Assert<Condition extends true> = Condition;

type MarkUnread = operations["markConversationUnread"];
type MarkUnreadBody = MarkUnread["responses"][200]["content"]["application/json"];
type PendingBody = MarkUnread["responses"][202]["content"]["application/json"];

export type ReadStateConsumerAssertions = [
  Assert<Equal<MarkUnread["requestBody"], undefined>>,
  Assert<Equal<MarkUnread["parameters"]["path"]["channelId"], string>>,
  Assert<Equal<MarkUnreadBody["outcome"], "counted" | "marked" | "nothing" | undefined>>,
  Assert<Equal<MarkUnreadBody["markedUnread"], boolean>>,
  Assert<Equal<MarkUnreadBody["unreadCount"], number>>,
  Assert<Equal<keyof MarkUnreadBody, "ok" | "unreadCount" | "maxReadSeq" | "readStateVersion" | "markedUnread" | "outcome">>,
  Assert<Equal<PendingBody["outcome"], "unknown">>,
];
