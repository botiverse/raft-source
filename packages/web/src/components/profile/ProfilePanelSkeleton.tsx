import type { ReactNode } from "react";
import { useMemo } from "react";
import { useIntl } from "react-intl";
import {
  PanelHeading,
  PanelMeta,
  PanelTitle,
  ProfilePanel as ProfilePanelFrame,
  ProfilePanelBody,
  Skeleton,
} from "@botiverse/raft-ui";
import PanelHeader, { PROFILE_HANDLE_FONT_CLASS } from "../ui/PanelHeader";
import { SkeletonTextBar } from "../ui/Skeleton";
import { TabBarRow } from "../../boot/bootSkeletons";
import { RowRegionBody } from "../layout/RowRegionBody";
import { useMediaQuery } from "../../hooks/effectPrimitives";
import { useMobileBack } from "../../hooks/useAppNavigate";
import { useColumnWidth } from "../../store/columnWidthStore";
import { useProfileStore } from "../../store/profileStore";
import { PROFILE_PANEL_OVERLAY_CLASS, profilePanelDesktopStyle } from "./profilePanelGeometry";

const LG_VIEWPORT_QUERY = "(min-width: 1024px)";

/** The profile's head, tab bar (an agent's) and hero in their own parts, with
 *  bars for what is not known yet, so the loaded profile lands where they were.
 *  Drawn while the profile's data loads (ProfilePanel) and, the same, while the
 *  panel's code loads (MainLayout's ProfilePanelFallback): an empty panel with
 *  a centred "Loading…" there made the head and tabs appear from nothing when a
 *  page opened on a profile (skeleton-vs-layout audit rounds 2 and 5). */
export function ProfilePanelSkeleton({
  profileType,
  onMobileBack,
  alwaysBack = false,
  actions,
}: {
  profileType: string | null;
  onMobileBack: () => void;
  /** An embedded page stack's back: shown on every screen. */
  alwaysBack?: boolean;
  actions?: ReactNode;
}) {
  const { formatMessage } = useIntl();
  const backTestId = profileType === "agent"
    ? "agent-mobile-back"
    : profileType === "external"
      ? "external-mobile-back"
      : "human-mobile-back";
  const mobileBackProps = useMemo(() => ({
    "data-testid": backTestId,
    title: formatMessage({ id: "common.announcement.back" }),
  }), [formatMessage, backTestId]);
  return (
    <>
      <PanelHeader
        title=""
        iconSlot={<Skeleton aria-hidden="true" className="size-[35px] md:pointer-fine:size-[27px]" />}
        iconAlwaysVisible
        iconKind="avatar"
        titleSlot={(
          <>
            <PanelHeading><PanelTitle render={<div />}><SkeletonTextBar className="w-32" /></PanelTitle></PanelHeading>
            <PanelMeta render={<div />} className={PROFILE_HANDLE_FONT_CLASS}><SkeletonTextBar className="w-20" /></PanelMeta>
          </>
        )}
        onMobileBack={onMobileBack}
        backButtonVisibility={alwaysBack ? "always" : "responsive"}
        mobileBackProps={mobileBackProps}
        actions={actions}
      />
      <RowRegionBody>
        <ProfilePanelBody className="flex min-h-0 flex-1 flex-col bg-layer-canvas font-sans" aria-busy="true" data-testid="profile-panel-loading">
          <span className="sr-only" role="status">{formatMessage({ id: "common.loading" })}</span>
          {profileType === "agent" ? <TabBarRow /> : null}
          {/* The hero (AgentDetailPanel's, HumanDetailPanel's): the 99px
              avatar, the name and the handle. */}
          <div className="flex items-start gap-4 px-(--surface-inset) py-5" aria-hidden="true" data-testid="profile-hero-skeleton">
            <Skeleton className="size-[99px] shrink-0" />
            <div className="min-w-0 flex-1 pt-1">
              <PanelTitle render={<div />}><SkeletonTextBar className="w-36" /></PanelTitle>
              <div className={`text-mono-meta ${PROFILE_HANDLE_FONT_CLASS}`}><SkeletonTextBar className="w-24" /></div>
            </div>
          </div>
        </ProfilePanelBody>
      </RowRegionBody>
    </>
  );
}

/** While the profile panel's code loads: the panel's own box (raft-ui
 *  ProfilePanel, the same classes and remembered width), holding its skeleton.
 *  It used to fill the rest of the row and then snap to the saved width when
 *  the panel arrived (task #157; Raft DS › Responsive layout, "The first frame
 *  is the settled one"). index.css folds the row around it as around the panel
 *  (`[data-profile-panel-fallback]`). */
export function ProfilePanelFallback({ testId }: { testId?: string } = {}) {
  const profileType = useProfileStore((s) => s.profileType);
  const onMobileBack = useMobileBack(useProfileStore((s) => s.closeProfile));
  const width = useColumnWidth("detail");
  const isLg = useMediaQuery(LG_VIEWPORT_QUERY);
  const style = useMemo(() => (isLg ? profilePanelDesktopStyle(width) : undefined), [isLg, width]);
  return (
    <ProfilePanelFrame
      data-profile-panel-fallback=""
      data-testid={testId}
      edge="attached"
      className={PROFILE_PANEL_OVERLAY_CLASS}
      style={style}
    >
      <ProfilePanelSkeleton profileType={profileType} onMobileBack={onMobileBack} />
    </ProfilePanelFrame>
  );
}
