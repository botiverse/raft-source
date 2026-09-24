export const AUTOCOMPLETE_TRIGGER_QUERY = String.raw`[\p{L}\p{N}_-]*`;
export const MENTION_TRIGGER = new RegExp(`@(${AUTOCOMPLETE_TRIGGER_QUERY})$`, "u");
export const CHANNEL_TRIGGER = new RegExp(`#(${AUTOCOMPLETE_TRIGGER_QUERY})$`, "u");
