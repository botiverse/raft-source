import { getRuntimeDisplayName, isRuntimeExperimental } from "@botiverse/raft-shared";
import type { RuntimeAvailabilitySuffix } from "@botiverse/raft-shared";
import type { MessageId } from "../i18n/messages/en";

// Runtime-availability suffix → catalog id.
//
// The classifier lives in @botiverse/raft-shared (locale-free, returns a KIND); the
// DISPLAY text lives in the catalog, so the zh UI renders （未安装）/（需更新 Raft
// Computer）/（即将推出）instead of the old hardcoded English suffixes. Same
// split as machineRunLabel: shared decides, web formats.
export function runtimeAvailabilityLabelId(
  suffix: RuntimeAvailabilitySuffix,
): MessageId | null {
  switch (suffix.kind) {
    case "none":
      return null;
    case "comingSoon":
      return "runtime.availability.comingSoon";
    case "updateComputer":
      return "runtime.availability.updateComputer";
    case "notInstalled":
      return "runtime.availability.notInstalled";
  }
}

/** Map the classifier kind to rendered text via the app catalog. */
export function formatRuntimeAvailabilitySuffix(
  suffix: RuntimeAvailabilitySuffix,
  formatMessage: (m: { id: MessageId }) => string,
): string {
  const id = runtimeAvailabilityLabelId(suffix);
  return id ? formatMessage({ id }) : "";
}

/**
 * Runtime label for IDENTITY DISPLAY (subtitles, badges, pickers): product name
 * plus lifecycle status.
 *
 * Prose sites -- anything interpolated into a sentence -- must use the bare
 * `getRuntimeDisplayName` instead, or the status suffix ends up mid-sentence
 * ("Check that Gemini CLI (deprecated) is installed").
 *
 * `deprecated` is the server's answer (`useRuntimeDeprecatedHere`, its
 * runtime-options rows or its catalog): a runtime it offers again (Antigravity
 * on OAR) is not deprecated there. Required, so no surface labels from the
 * bundled flag by default; the hooks fall back to it for an old server.
 */
export function formatRuntimeLabelWithStatus(
  runtimeId: string,
  formatMessage: (m: { id: MessageId }) => string,
  deprecated: boolean,
): string {
  const name = getRuntimeDisplayName(runtimeId);
  if (deprecated) return `${name}${formatMessage({ id: "runtime.availability.deprecated" })}`;
  if (isRuntimeExperimental(runtimeId)) return `${name}${formatMessage({ id: "runtime.availability.experimental" })}`;
  return name;
}

/**
 * Runtime label for a place that draws raft-ui's `Badge.Experimental` beside
 * the name (the runtime pickers; the Computer page chips keep the text): the
 * product name plus a deprecated suffix, without the "(experimental)" text the
 * badge says instead. Pair with `runtimeShowsExperimentalBadge`.
 *
 * `deprecated` is the server's answer, as in `formatRuntimeLabelWithStatus`.
 */
export function formatRuntimeLabelBesideBadge(
  runtimeId: string,
  formatMessage: (m: { id: MessageId }) => string,
  deprecated: boolean,
): string {
  const name = getRuntimeDisplayName(runtimeId);
  return deprecated ? `${name}${formatMessage({ id: "runtime.availability.deprecated" })}` : name;
}

/** Whether `formatRuntimeLabelBesideBadge`'s name gets an Experimental badge
 *  (deprecated wins, as in `formatRuntimeLabelWithStatus`). */
export function runtimeShowsExperimentalBadge(runtimeId: string, deprecated: boolean): boolean {
  return !deprecated && isRuntimeExperimental(runtimeId);
}
