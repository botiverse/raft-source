import type { IntlShape } from "react-intl";
import type { ConfirmRequest } from "@botiverse/porthole";

import { CONFIRM_TEXT_LIMITS, formatBounded } from "./artifactConfirmText";

type FormatMessage = IntlShape["formatMessage"];

/**
 * What Raft's confirm dialog (ArtifactFrameConfirm) says for a gated call a framed page made, one
 * shape for every kind Porthole 0.14.17's default dialog words (its `words`, dialog.tsx): the title
 * and accept button are Porthole's, the detail is the call's whole effect as Porthole shows it
 * (P019, P094, P095). Porthole's helper lines are dropped ("It opens <host>.": the host is in bold
 * in the URL instead, Jasper), except the one the contract requires: a detail cut to its bounds
 * says only part is shown (`partial`).
 */
export interface ConfirmWords {
  readonly title: string;
  readonly accept: string;
  /** The accept leaves Raft (a link): it carries ↗. */
  readonly leavesRaft: boolean;
  /** A line above the detail: what asked for the yes in a db change, a publish's base. */
  readonly summary?: string;
  /** What the person is shown in full. */
  readonly detail: string;
  /** For a link, the detail split around its host (`new URL(url).host`), drawn in bold. */
  readonly link?: { readonly before: string; readonly host: string; readonly after: string };
  /** The detail is cut to the dialog's bounds (P095). */
  readonly partial: boolean;
}

/** A link's address as it opens (openFrameLink opens `href`), split around its host. */
function linkParts(raw: string): Pick<ConfirmWords, "detail" | "link"> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { detail: raw };
  }
  const { href, host, protocol, username, password } = url;
  const userinfo = username || password ? `${username}${password ? `:${password}` : ""}@` : "";
  const before = `${protocol}//${userinfo}`;
  if (host === "" || !href.startsWith(`${before}${host}`)) return { detail: href };
  return { detail: href, link: { before, host, after: href.slice(before.length + host.length) } };
}

/** How many paths of one kind of write the summary names before it counts the rest. */
const MOST_PATHS = 10;

/**
 * A db change in a line (P094): the writes whose own gates asked for the yes, by kind, or every
 * write by kind where none of them asked; at most `MOST_PATHS` paths a kind, then a count.
 */
function writesSummary(
  writes: readonly { readonly op: string; readonly path: string }[],
  askedBy: readonly string[],
  formatMessage: FormatMessage,
): string {
  const asked = writes.filter((each) => askedBy.includes(each.op));
  const lead = asked.length === 0 ? writes : asked;
  const kinds = new Map<string, string[]>();
  for (const each of lead) kinds.set(each.op, [...(kinds.get(each.op) ?? []), each.path]);
  const said = [...kinds]
    .map(([op, paths]) =>
      formatMessage(
        { id: "artifacts.confirm.db.kind" },
        { op, paths: paths.slice(0, MOST_PATHS).join(", "), more: Math.max(0, paths.length - MOST_PATHS) },
      ),
    )
    .join(formatMessage({ id: "artifacts.confirm.db.kindSeparator" }));
  const text = formatMessage({ id: "artifacts.confirm.db.summary" }, { kinds: said, others: writes.length - lead.length });
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function confirmWords(request: ConfirmRequest, formatMessage: FormatMessage): ConfirmWords {
  const said = (title: string, accept: string, detail: string, rest: Partial<ConfirmWords> = {}): ConfirmWords => ({
    title,
    accept,
    leavesRaft: false,
    detail,
    partial: false,
    ...rest,
  });
  const carried = (title: string, accept: string, value: unknown, before = ""): ConfirmWords => {
    const { text, whole } = formatBounded(value, CONFIRM_TEXT_LIMITS, 2);
    return said(title, accept, `${before}${text}`, { partial: !whole });
  };
  const allow = formatMessage({ id: "artifacts.confirm.allow" });
  const allowThis = formatMessage({ id: "artifacts.confirm.allowThis" });
  switch (request.capability) {
    case "sendPrompt":
      return said(formatMessage({ id: "artifacts.confirm.sendPrompt.title" }), formatMessage({ id: "artifacts.confirm.sendPrompt.accept" }), request.args.text);
    case "openLink":
      return {
        ...said(formatMessage({ id: "artifacts.confirm.openLink.title" }), formatMessage({ id: "artifacts.confirm.openLink.accept" }), ""),
        leavesRaft: true,
        ...linkParts(request.args.url),
      };
    case "downloadFile":
      return carried(formatMessage({ id: "artifacts.confirm.downloadFile.title" }), formatMessage({ id: "artifacts.confirm.downloadFile.accept" }), request.args.contents);
    case "callTool":
      return carried(formatMessage({ id: "artifacts.confirm.callTool.title" }), formatMessage({ id: "artifacts.confirm.callTool.accept" }), request.args.arguments, `${request.args.name}\n`);
    case "setModelContext":
      return carried(formatMessage({ id: "artifacts.confirm.setModelContext.title" }), formatMessage({ id: "artifacts.confirm.setModelContext.accept" }), request.args);
    case "readData":
      return said(formatMessage({ id: "artifacts.confirm.readData.title" }), allow, request.args.uri);
    case "subscribeData":
      return said(formatMessage({ id: "artifacts.confirm.subscribeData.title" }), allow, request.args.uri);
    case "copyText":
      return said(formatMessage({ id: "artifacts.confirm.copyText.title" }), formatMessage({ id: "artifacts.confirm.copyText.accept" }), request.args.text);
    case "artifact": {
      const args = request.args;
      if (args.op !== "publish") return carried(allowThis, allow, args);
      const files = Object.entries(args.files).map(([path, file]) =>
        file === null
          ? formatMessage({ id: "artifacts.confirm.publish.removed" }, { path })
          : "text" in file
            ? formatMessage({ id: "artifacts.confirm.publish.characters" }, { path, count: file.text.length })
            : formatMessage({ id: "artifacts.confirm.publish.bytes" }, { path, count: Math.floor((file.base64.length * 3) / 4) }),
      );
      return said(formatMessage({ id: "artifacts.confirm.publish.title" }), formatMessage({ id: "artifacts.confirm.publish.accept" }), files.join("\n"), {
        summary: args.label === undefined
          ? formatMessage({ id: "artifacts.confirm.publish.base" }, { base: args.base })
          : formatMessage({ id: "artifacts.confirm.publish.baseLabel" }, { base: args.base, label: args.label }),
      });
    }
    case "assets": {
      const args = request.args;
      if (args.op === "upload") {
        return said(
          formatMessage({ id: "artifacts.confirm.assetUpload.title" }),
          formatMessage({ id: "artifacts.confirm.assetUpload.accept" }),
          formatMessage({ id: "artifacts.confirm.assetUpload.detail" }, { name: args.name, type: args.type, size: args.size }),
          // Who can load it is the upload's effect, not a helper line: Porthole's note, kept.
          { summary: formatMessage({ id: "artifacts.confirm.assetUpload.audience" }) },
        );
      }
      if (args.op === "delete") {
        return said(formatMessage({ id: "artifacts.confirm.assetDelete.title" }), formatMessage({ id: "artifacts.confirm.assetDelete.accept" }), args.id);
      }
      return carried(allowThis, allow, args);
    }
    case "db": {
      const args = request.args;
      const writes = args.op === "batch" ? args.writes : args.op === "set" || args.op === "update" || args.op === "delete" ? [args] : null;
      if (writes === null) return carried(allowThis, allow, args);
      return {
        ...carried(formatMessage({ id: "artifacts.confirm.db.title" }), formatMessage({ id: "artifacts.confirm.db.accept" }), args),
        summary: writesSummary(writes, request.askedBy ?? [], formatMessage),
      };
    }
    default:
      return carried(allowThis, allow, request.args);
  }
}
