// FormatJS global type augmentation — enforces the MessageId rail at callsites.
//
// Without this, react-intl types a message `id` as plain `string`, so a typo
// (`common.confirm.canel`) would compile and only surface at runtime as a raw
// id. Declaring `FormatjsIntl.Message.ids` narrows the `id` accepted by
// `formatMessage({ id })` / `<FormattedMessage id>` to the union derived from
// the en source-of-truth catalog — a mistyped or not-yet-defined id is now a
// typecheck error everywhere, no per-callsite wrapper needed.

import type { MessageId } from "./messages/en";

declare global {
  namespace FormatjsIntl {
    interface Message {
      ids: MessageId;
    }
  }
}
