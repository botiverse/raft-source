import { TriangleAlert } from "lucide-react";
import { useMemo } from "react";
import { useIntl } from "react-intl";
import { Banner, BannerClose, BannerDescription, BannerTitle } from "@botiverse/raft-ui";
import { descriptionLinkFixesOf } from "@botiverse/raft-shared";
import type { DescriptionLinkFix, DescriptionLinkWarning } from "@botiverse/raft-shared";
import type { MessageId } from "../../i18n/messages";

const FIX_ID = {
  public_copy: "profile.linkWarnings.fix.publicCopy",
  leave_out: "profile.linkWarnings.fix.leaveOut",
  make_public: "profile.linkWarnings.fix.makePublic",
  widen_to_server: "profile.linkWarnings.fix.widenToServer",
  replace_link: "profile.linkWarnings.fix.replaceLink",
} as const satisfies Record<DescriptionLinkFix, MessageId>;

const PROBLEM_ID = {
  unavailable: "profile.linkWarnings.unavailable",
  other_server: "profile.linkWarnings.otherServer",
  conversation: "profile.linkWarnings.conversation",
  server_partial: "profile.linkWarnings.serverPartial",
} as const satisfies Record<DescriptionLinkWarning["code"], MessageId>;

function whoCantRead(warning: DescriptionLinkWarning): "guests" | "otherServers" | "both" {
  const guests = warning.unreadable?.includes("guests") ?? false;
  const others = warning.unreadable?.includes("other_servers") ?? false;
  return guests && others ? "both" : others ? "otherServers" : "guests";
}

/**
 * #457: after a description is saved, the links in it some of its readers
 * can't open, one entry per link (a person's description warns per server:
 * each server's sentence under its link), with every fix that applies once
 * (shared descriptionLinkFixesOf for whose description it is, in its order: the widest audience last; an agent's copy only needs to reach its server), as a
 * person does them in the web.
 * The save itself succeeded; this stays until dismissed.
 */
export function DescriptionLinkWarnings({ warnings, owner, onDismiss }: {
  warnings: readonly DescriptionLinkWarning[];
  /** Whose description: an agent's is shown to its server only, a person's to everyone who can see them. */
  owner: "agent" | "person";
  onDismiss: () => void;
}) {
  const { formatMessage } = useIntl();
  const links = useMemo(() => {
    const byUrl = new Map<string, DescriptionLinkWarning[]>();
    for (const warning of warnings) byUrl.set(warning.url, [...(byUrl.get(warning.url) ?? []), warning]);
    return [...byUrl];
  }, [warnings]);
  if (links.length === 0) return null;
  return (
    <Banner status="warning" size="sm" role="status" data-testid="description-link-warnings">
      <TriangleAlert />
      <BannerTitle>{formatMessage({ id: "profile.linkWarnings.title" }, { count: links.length })}</BannerTitle>
      <BannerDescription>
        <ul className="stack-y-2">
          {links.map(([url, about]) => (
            <li key={url} className="stack-y-1" data-testid="description-link-warning">
              {about.map((warning) => (
                <p key={`${warning.code}:${warning.server?.id ?? ""}`} className="break-words">
                  {formatMessage({ id: PROBLEM_ID[warning.code] }, {
                    url,
                    hasServer: warning.server ? "yes" : "no",
                    server: warning.server?.name ?? "",
                    who: whoCantRead(warning),
                  })}
                </p>
              ))}
              <ul className="list-disc stack-y-0.5 ps-4">
                {descriptionLinkFixesOf(about.map((warning) => warning.code), owner).map((fix) => (
                  <li key={fix}>{formatMessage({ id: fix === "public_copy" && owner === "agent" ? "profile.linkWarnings.fix.publicCopyServer" : FIX_ID[fix] })}</li>
                ))}
              </ul>
            </li>
          ))}
          <li>{formatMessage({ id: owner === "agent" ? "profile.linkWarnings.reminderAgent" : "profile.linkWarnings.reminder" })}</li>
        </ul>
      </BannerDescription>
      <BannerClose aria-label={formatMessage({ id: "profile.linkWarnings.dismiss" })} onClick={onDismiss} />
    </Banner>
  );
}
