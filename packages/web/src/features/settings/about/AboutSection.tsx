import { TextLink, TextLinkExternalIcon } from "@botiverse/raft-ui";
import { opensInNewTabAriaLabel } from "../../../components/ui/LeavingRaftMark";
import { Building2, Tag, Smartphone, Monitor } from "lucide-react";
import DesktopDownloadOptions from "../../../components/settings/DesktopDownloadOptions";
import { MobileAppDownloads } from "./MobileAppDownloads";
import { useServerStore } from "../../../store/serverStore";
import { isElectronDesktopShell } from "../../../utils/desktopShell";
import { useIntl } from "react-intl";
import { WEB_APP_VERSION } from "../../../utils/webAppVersion";
import SectionHeader from "../../../components/ui/SectionHeader";
import SurfaceListItem from "../../../components/ui/SurfaceListItem";

/** The server and web's public source: a snapshot per release of this repository. */
const RAFT_SOURCE_URL = "https://github.com/botiverse/raft-source";
/** Its license, by name (a name, not prose: the same in every locale): FSL-1.1-ALv2 with additional conditions, the repository's LICENSE. */
const RAFT_SOURCE_LICENSE = "Raft License";

// Exported for settingsSubBatchC.i18n.behavior.test.tsx (removed in the 2026-11 web DOM test prune) — rendered directly so the
// zh teeth exercise the real component without mounting the full SettingsPanel
// (whose account tab reads the Vite-only `import.meta.env` graph). Same precedent
// as the exported `AccountSection` used by sub-batch A.
export function AboutSection({
  appVersion = WEB_APP_VERSION,
  showWorkspace = true,
}: {
  appVersion?: string;
  showWorkspace?: boolean;
} = {}) {
  const { formatMessage } = useIntl();
  const currentServer = useServerStore((s) => s.current);

  return (
    <div className="stack-y-6">
      <section className="stack-y-3">
        <SectionHeader label={formatMessage({ id: "settings.about.versionSectionLabel" })} icon={<Tag size={16} />} />
        <SurfaceListItem interactive={false} className="stack-y-1">
          {/* Product wordmark — catalog brand id; locale values may match. */}
          <div className="text-subhead font-semibold text-foreground">{formatMessage({ id: "brand.productName" })}</div>
          <div className="font-mono text-mono-meta text-foreground-muted">{appVersion}</div>
          {/* Source-available, not open source: FSL turns Apache 2.0 after two years, so the label says
              Source code and names the license (Tenny, #proj-mobile:245a95b8). The App's About links its own repo. */}
          <div className="flex flex-wrap items-baseline gap-x-2 text-footnote text-foreground-muted" data-testid="settings-about-source-code">
            <TextLink
              render={<a href={RAFT_SOURCE_URL} target="_blank" rel="noopener noreferrer" aria-label={opensInNewTabAriaLabel(formatMessage, formatMessage({ id: "settings.about.sourceCode" }))} />}
              variant="strong"
            >
              {formatMessage({ id: "settings.about.sourceCode" })}
              <TextLinkExternalIcon label={formatMessage({ id: "common.opensInNewTab" })} />
            </TextLink>
            <span className="font-mono text-mono-meta">{RAFT_SOURCE_LICENSE}</span>
          </div>
        </SurfaceListItem>
      </section>

      {/*
        Desktop app: offered on the web only. Inside Raft Desktop the reader
        already has it, and updates arrive in-app.
      */}
      {isElectronDesktopShell() ? null : (
        <section id="desktop-app" className="stack-y-3">
          <SectionHeader label={formatMessage({ id: "settings.desktopApp.sectionLabel" })} icon={<Monitor size={16} />} />
          <SurfaceListItem interactive={false}>
            <DesktopDownloadOptions />
          </SurfaceListItem>
        </section>
      )}

      {/*
        Mobile app is a companion surface, not an entry point: someone who
        installs it without a connected Computer still cannot use Raft, which is
        why this lives here rather than on the landing page (@wenyi). The Help
        menu carries only a signpost to it — this section is the single content
        host, so there is exactly one place to keep current.
      */}
      <section className="stack-y-3">
        <SectionHeader label={formatMessage({ id: "settings.mobileApp.sectionLabel" })} icon={<Smartphone size={16} />} />
        <SurfaceListItem interactive={false}>
          <MobileAppDownloads />
        </SurfaceListItem>
      </section>

      {showWorkspace ? <section className="stack-y-3" data-testid="settings-about-workspace">
        <SectionHeader label={formatMessage({ id: "settings.about.workspaceSectionLabel" })} icon={<Building2 size={16} />} />
        <SurfaceListItem interactive={false} className="stack-y-1">
          <div className="text-subhead font-semibold text-foreground">{currentServer?.name ?? formatMessage({ id: "settings.about.workspaceNameFallback" })}</div>
          {/* The slug when there is one; no pointer sentence in its place (HelperText step 1: a CUT). */}
          {currentServer?.slug ? <div className="font-mono text-mono-meta text-foreground-muted">{`/${currentServer.slug}`}</div> : null}
        </SurfaceListItem>
      </section> : null}
    </div>
  );
}
