import { StrictMode } from "react";
import ReactDOM from "react-dom/client";
import api from "../../src/api/client";
import { DesktopBrowserSignInSheet } from "../../src/features/desktopBrowserSignIn/DesktopBrowserSignInSheet";
import { desktopBrowserSignInRequest } from "../../src/features/desktopBrowserSignIn/desktopBrowserSignInRequest";
import { preloadInitialLocaleMessages } from "../../src/i18n/preloadLocaleMessages";
import { useAuthStore } from "../../src/store/authStore";
import { useServerStore } from "../../src/store/serverStore";
import type { Server } from "../../src/store/serverStore";
import { VisualTestingRoot } from "../VisualTestingRoot";
import "../../src/index.css";

// Raft Desktop's "Sign in with Raft" sheet (desktop_browser_raft_sign_in_v0)
// drawn with the real component and no server, for local screenshots
// (desktop-browser-sign-in.shot.mjs):
// ?mode=light|dark&servers=1|2|8&layout=server|install|account&logo=0|1. The
// App's lookup is answered here; `servers` is how many Servers it is on
// (1: the Server is a line; 2: the picker; 8: a long list of scopes too, so
// the body has to scroll). `layout`: server, ready on each Server (the
// default); install, a Marketplace App the person installs first (Install and
// continue); account, an App that signs in with the Raft account, no Server.
// `logo=1`: the App has a registered logo (app-logo.svg here), else initials.
const params = new URLSearchParams(window.location.search);
const mode = params.get("mode") === "dark" ? "dark" : "light";
const count = Math.max(1, Number(params.get("servers")) || 2);
const layout = params.get("layout") === "install" ? "install" : params.get("layout") === "account" ? "account" : "server";
const logoUrl = params.get("logo") === "1" ? "/visual-testing/desktop-browser-sign-in/app-logo.svg" : null;
const RETURN_URL = "https://thumbs-separation-similarly-dsc.trycloudflare.com/callback";
const scope = count >= 8 ? "openid profile agent:read app:read" : "openid profile";
const setupSearch = `?flow=oidc&client_id=qa-walk&return_to=${encodeURIComponent(RETURN_URL)}&scope=${encodeURIComponent(scope)}&state=s`;

const servers = Array.from({ length: count }, (_, index): Server => ({
  id: `server-${index + 1}`,
  name: index === 0 ? "QA Workspace Artifacts" : `Workspace ${index + 1}`,
  avatarUrl: null,
  slug: index === 0 ? "qa-wa-1ilac" : `workspace-${index + 1}`,
  ownerId: "user-1",
  onboardingAgentId: null,
  hideHumansFromMembers: false,
  plan: "pro",
  planDowngradedAt: null,
  role: "owner",
  createdAt: "2026-06-25T00:00:00.000Z",
}));
useAuthStore.setState({
  user: { id: "user-1", email: "innout-wa-member-126946@mail.build", name: "Member", displayName: "Member", avatarUrl: null, emailVerified: true },
  accessToken: "fixture",
  refreshToken: "fixture",
  loading: false,
  initialized: true,
} as never);
useServerStore.setState({ servers, current: servers[0], members: [], loading: false } as never);
api.get = (async (_url: string, config?: { params?: { server_id?: string } }) => ({
  data: {
    id: "app-1",
    clientId: "qa-walk",
    appType: "third_party_global",
    name: "QA sign-in walk (throwaway)",
    description: "Throwaway client for the #285 staging walk. Delete after use.",
    homepageUrl: "https://example.com/",
    returnUrl: RETURN_URL,
    logoUrl,
    ...(layout === "install" ? {
      marketplace: true,
      availability: "install_required",
      installation: { serverId: config?.params?.server_id ?? "server-1", canInstall: true },
    } : { availability: "ready" }),
    ...(layout === "account" ? { loginMode: "account" } : {}),
  },
})) as unknown as typeof api.get;
api.post = (async () => ({ data: { evaluations: [] } })) as unknown as typeof api.post;

const ignore = () => {};
// The request as the host makes it from the shell's (the same parse and checks).
const request = desktopBrowserSignInRequest({ requestId: "fixture", setupSearch })!;

const render = () => ReactDOM.createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <VisualTestingRoot mode={mode}>
      <div className="h-screen bg-layer-sidebar" />
      <DesktopBrowserSignInSheet request={request} preferredServerId="server-1" onResult={ignore} onClose={ignore} />
    </VisualTestingRoot>
  </StrictMode>,
);
const ready = preloadInitialLocaleMessages();
if (ready) void ready.then(render);
else render();
