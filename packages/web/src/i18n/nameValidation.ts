import type { IntlShape } from "react-intl";
import type { AgentNameValidationReason, NameValidationReason } from "@botiverse/raft-shared";

import type { MessageId } from "./messages";

/**
 * Format a name-validation failure entirely from the catalog.
 *
 * `validateName` from @botiverse/raft-shared interpolates a label into an ENGLISH
 * sentence frame. Passing it a translated label therefore yields a
 * mixed-language string ("频道名称 is required") — which reads worse than
 * leaving the whole thing English, and is invisible to a scanner because no
 * English literal appears at the call site. Localized surfaces must take the
 * reason code and build the whole sentence here instead.
 *
 * `label` is a MessageId, not a string, so a call site cannot accidentally pass
 * raw English back in.
 */
export function formatNameValidationError(
  reason: NameValidationReason | null,
  label: MessageId,
  formatMessage: IntlShape["formatMessage"],
): string | null {
  if (!reason) return null;
  const labelText = formatMessage({ id: label });
  switch (reason.code) {
    case "required":
      return formatMessage({ id: "validation.name.required" }, { label: labelText });
    case "tooShort":
      return formatMessage({ id: "validation.name.tooShort" }, { label: labelText, min: reason.minLength });
    case "tooLong":
      return formatMessage({ id: "validation.name.tooLong" }, { label: labelText, max: reason.maxLength });
    case "pattern":
      return formatMessage({ id: "validation.name.pattern" }, { label: labelText });
    default: {
      const _exhaustive: never = reason;
      return _exhaustive;
    }
  }
}

export function formatAgentNameValidationError(
  reason: AgentNameValidationReason | null,
  label: MessageId,
  formatMessage: IntlShape["formatMessage"],
): string | null {
  if (!reason) return null;
  if (reason.code === "reserved") {
    const labelText = formatMessage({ id: label });
    return formatMessage(
      { id: "validation.name.reserved" },
      { label: labelText, handle: reason.handle },
    );
  }
  return formatNameValidationError(reason, label, formatMessage);
}
