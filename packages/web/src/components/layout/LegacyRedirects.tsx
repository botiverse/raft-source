import { Navigate } from "react-router-dom";
import { useServerStore } from "../../store/serverStore";

/** Route: /workspace, from the removed Workspace grid layout: the server's home. */
export function LegacyWorkspaceGridRedirect() {
  const slug = useServerStore((s) => s.current?.slug);
  return <Navigate to={slug ? `/s/${slug}` : "/"} replace />;
}

/** Routes: /inbox and /threads, now Activity. */
export function LegacyThreadsRedirect() {
  const slug = useServerStore((s) => s.current?.slug);
  return <Navigate to={slug ? `/s/${slug}/activity` : "/"} replace />;
}

/** Route: /members/graph, from the removed member relationship graph: the Members page. */
export function LegacyMemberGraphRedirect() {
  const slug = useServerStore((s) => s.current?.slug);
  return <Navigate to={slug ? `/s/${slug}/members` : "/"} replace />;
}
