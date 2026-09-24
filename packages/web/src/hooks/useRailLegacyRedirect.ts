import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";

// Bridges the older URL shapes (?sidebarTab=, ?tab=machines, /machine/<id>)
// onto the canonical path-based rail-mode URLs. Path is the single source of
// truth for the active rail mode, so any leftover query-param signaling has
// to be folded back into the path on landing.
//
// Old → new:
//   /s/<slug>?sidebarTab=members   → /s/<slug>/members
//   /s/<slug>?sidebarTab=computers → /s/<slug>/computers
//   /s/<slug>?tab=machines         → /s/<slug>/computers
//   /s/<slug>/agent/<id>?sidebarTab=... → strip the param, keep the path
//   /s/<slug>/machine/<id>         → /s/<slug>/computer/<id>
//
// Mounted once at the top of MainLayout. Replace-only, no history entry.
export function useRailLegacyRedirect(): void {
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const sidebarTab = params.get("sidebarTab");
    const legacyTab = params.get("tab");

    let nextPath = location.pathname;
    let changed = false;

    // /machine/<id> → /computer/<id>
    const machineMatch = location.pathname.match(/^(\/s\/[^/]+)\/machine\/([^/?#]+)$/);
    if (machineMatch) {
      nextPath = `${machineMatch[1]}/computer/${machineMatch[2]}`;
      changed = true;
    }

    // ?sidebarTab=<v> on a server root → fold into /members or /computers path
    const serverRootMatch = nextPath.match(/^(\/s\/[^/]+)\/?$/);
    if (serverRootMatch) {
      if (sidebarTab === "members") {
        nextPath = `${serverRootMatch[1]}/members`;
        changed = true;
      } else if (sidebarTab === "computers") {
        nextPath = `${serverRootMatch[1]}/computers`;
        changed = true;
      } else if (legacyTab === "machines") {
        nextPath = `${serverRootMatch[1]}/computers`;
        changed = true;
      }
    }

    // Strip the now-meaningless rail-mode query keys from any URL that still
    // has them. Other query keys (?profile=, ?thread=, ?msg=, ?agentTab=,
    // ?chatTab=, ?q=) belong to other surfaces and stay intact.
    if (sidebarTab !== null || (legacyTab === "machines" || legacyTab === "messages")) {
      params.delete("sidebarTab");
      if (legacyTab === "machines" || legacyTab === "messages") {
        params.delete("tab");
      }
      changed = true;
    }

    if (!changed) return;
    const search = params.toString();
    navigate(`${nextPath}${search ? `?${search}` : ""}${location.hash}`, { replace: true });
  }, [location.pathname, location.search, location.hash, navigate]);
}
