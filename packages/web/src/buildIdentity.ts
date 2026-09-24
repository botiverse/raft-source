export type WebBuildIdentity = {
  sha: string | null;
  builtAt: string | null;
  branch: string | null;
};

export type FrontendReleaseIdentity = Readonly<{
  releaseId: string | null;
  commitSha: string | null;
  builtAt: string | null;
  branch: string | null;
  deploymentEnvironment: string | null;
}>;

declare const __RAFT_FRONTEND_RELEASE_IDENTITY__:
  | FrontendReleaseIdentity
  | undefined;

declare global {
  interface Window {
    __RAFT_BUILD_IDENTITY__?: WebBuildIdentity;
    __RAFT_FRONTEND_RELEASE_IDENTITY__?: FrontendReleaseIdentity;
  }
}

const EMPTY_FRONTEND_RELEASE_IDENTITY: FrontendReleaseIdentity = Object.freeze({
  releaseId: null,
  commitSha: null,
  builtAt: null,
  branch: null,
  deploymentEnvironment: null,
});

function readFrontendReleaseIdentity(): FrontendReleaseIdentity {
  try {
    if (
      typeof __RAFT_FRONTEND_RELEASE_IDENTITY__ === "object" &&
      __RAFT_FRONTEND_RELEASE_IDENTITY__ !== null
    ) {
      return Object.freeze({ ...__RAFT_FRONTEND_RELEASE_IDENTITY__ });
    }
  } catch {
    // A non-Vite test runner has no compile-time define. Missing identity stays
    // explicit nulls rather than becoming a plausible stale value.
  }
  return EMPTY_FRONTEND_RELEASE_IDENTITY;
}

export const FRONTEND_RELEASE_IDENTITY = readFrontendReleaseIdentity();

export const WEB_BUILD_IDENTITY: WebBuildIdentity = Object.freeze({
  sha: FRONTEND_RELEASE_IDENTITY.commitSha,
  builtAt: FRONTEND_RELEASE_IDENTITY.builtAt,
  branch: FRONTEND_RELEASE_IDENTITY.branch,
});

export function exposeWebBuildIdentity(
  targetWindow: Pick<
    Window,
    "__RAFT_BUILD_IDENTITY__" | "__RAFT_FRONTEND_RELEASE_IDENTITY__"
  >,
  targetDocument: Pick<Document, "documentElement">,
  identity: FrontendReleaseIdentity = FRONTEND_RELEASE_IDENTITY,
): void {
  const webIdentity: WebBuildIdentity = Object.freeze({
    sha: identity.commitSha,
    builtAt: identity.builtAt,
    branch: identity.branch,
  });
  targetWindow.__RAFT_FRONTEND_RELEASE_IDENTITY__ = identity;
  targetWindow.__RAFT_BUILD_IDENTITY__ = webIdentity;

  const { dataset } = targetDocument.documentElement;
  if (identity.releaseId) dataset.raftFrontendReleaseId = identity.releaseId;
  else delete dataset.raftFrontendReleaseId;
  if (identity.commitSha) dataset.raftBuildSha = identity.commitSha;
  else delete dataset.raftBuildSha;
  if (identity.builtAt) dataset.raftBuildBuiltAt = identity.builtAt;
  else delete dataset.raftBuildBuiltAt;
  if (identity.branch) dataset.raftBuildBranch = identity.branch;
  else delete dataset.raftBuildBranch;
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  exposeWebBuildIdentity(window, document);
}
