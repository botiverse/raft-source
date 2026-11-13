import { Suspense } from "react";
import { useIntl } from "react-intl";
import { Navigate } from "react-router-dom";
import { deferredPanel } from "../../boot/deferredUi";
import { PanelLoading } from "../../components/layout/PanelLoading";
import { useServerStore } from "../../store/serverStore";

// A page the rail's Members button opens, off the default route: out of the
// first download (docs/frontend/boot-bundle.md), fetched in the background
// after the first screen.
const MembersPage = deferredPanel(() => import("./MembersPage").then((module) => ({ default: module.MembersPage })));

/**
 * The /members root route: the Members page, a full page beside the rail on
 * desktop and a pushed page on a phone (shellRouteLayout gives it no
 * sidebar). Unlike DefaultRoute, it MUST NOT auto-redirect to the first
 * channel — that would silently flip the URL into chat mode (and re-highlight
 * the Chat rail button) the moment the user clicks Members. A Guest has no
 * Members page.
 */
export function MembersEmptyRoute() {
  const { formatMessage } = useIntl();
  const server = useServerStore((s) => s.current);
  if (server?.role === "guest") {
    return <Navigate to={server.slug ? `/s/${server.slug}` : "/"} replace />;
  }
  return (
    <Suspense fallback={<PanelLoading label={formatMessage({ id: "layout.main.loading" })} />}>
      <MembersPage />
    </Suspense>
  );
}
