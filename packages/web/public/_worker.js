const BUILT_ASSET_PREFIX = "/assets/";
const DESKTOP_MANIFEST_PATH = "/desktop-manifest.json";
const IMMUTABLE_ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable";
const MAX_DESKTOP_MANIFEST_BYTES = 65_536;
const WELL_KNOWN_PREFIX = "/.well-known/";
const WELL_KNOWN_CHANGE_PASSWORD_PATH = `${WELL_KNOWN_PREFIX}change-password`;
const CHANGE_PASSWORD_INTENT_PATH = "/change-password";

function isBuiltAssetRequest(request) {
  return new URL(request.url).pathname.startsWith(BUILT_ASSET_PREFIX);
}

function isHtmlResponse(response) {
  return /^text\/html(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "");
}

function isDesktopManifestRequest(request) {
  return new URL(request.url).pathname === DESKTOP_MANIFEST_PATH;
}

function unavailableDesktopManifestResponse() {
  return Response.json(
    { error: "desktop_manifest_unavailable" },
    {
      status: 404,
      statusText: "Not Found",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}

function isJsonResponse(response) {
  return /^application\/json(?:\s*;|$)/i.test(
    response.headers.get("content-type") ?? "",
  );
}

function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function readBoundedDesktopManifestBody(response) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_DESKTOP_MANIFEST_BYTES
  ) {
    return null;
  }

  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > MAX_DESKTOP_MANIFEST_BYTES) {
        await reader.cancel("desktop manifest exceeds byte limit");
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function normalizeDesktopManifestResponse(request, response) {
  if (!isDesktopManifestRequest(request)) return response;
  if (response.status !== 200 || !isJsonResponse(response)) {
    return unavailableDesktopManifestResponse();
  }

  const body = await readBoundedDesktopManifestBody(response);
  if (body === null) {
    return unavailableDesktopManifestResponse();
  }
  try {
    const decoded = new TextDecoder().decode(body);
    const parsed = JSON.parse(decoded);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return unavailableDesktopManifestResponse();
    }
  } catch {
    return unavailableDesktopManifestResponse();
  }

  const digest = await crypto.subtle.digest("SHA-256", body);
  const headers = new Headers(response.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-cache, must-revalidate");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("ETag", `"sha256-${bytesToHex(new Uint8Array(digest))}"`);
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function normalizeBuiltAssetResponse(request, response) {
  if (!isBuiltAssetRequest(request)) return response;
  if (response.status !== 404 && !isHtmlResponse(response)) {
    if (!response.ok) return response;

    const headers = new Headers(response.headers);
    headers.set("Cache-Control", IMMUTABLE_ASSET_CACHE_CONTROL);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  return new Response(null, {
    status: 404,
    statusText: "Not Found",
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}


/**
 * App Links / Universal Links association files.
 *
 * Served from the Worker, NOT from `public/.well-known/`, because Cloudflare
 * Pages drops dot-directories at upload. Measured on a preview deploy before
 * writing this: the file was present in `dist/.well-known/` after the Vite
 * build, and the deployed site answered
 *
 *   GET /.well-known/assetlinks.json  → 200  text/html   (the SPA shell)
 *
 * byte-identical to a nonexistent path. **200, not 404** — so any "is the URL
 * reachable" check passes while the OS receives HTML and association silently
 * never verifies. That is the exact failure this whole feature is trying to
 * avoid, so these paths are answered here where nothing can swallow them.
 *
 * Both must be `application/json`. Apple additionally does NOT follow redirects
 * when fetching the AASA, so this has to be a direct 200 at the exact path, and
 * `apple-app-site-association` has no file extension by design.
 *
 * Contents frozen by @Mahua from the real signed artifacts (#proj-mobile):
 * Android package + both signing certs (legacy and rotated — a device on either
 * must verify), iOS appID from the Team ID in the live signed IPA. Scope is
 * exactly `/download`; nothing else is claimed, so no other Raft URL changes
 * behaviour on a device that has the app.
 */
const WELL_KNOWN_ASSETLINKS_PATH = "/.well-known/assetlinks.json";
const WELL_KNOWN_AASA_PATH = "/.well-known/apple-app-site-association";

const ANDROID_ASSETLINKS = [
  {
    relation: ["delegate_permission/common.handle_all_urls"],
    target: {
      namespace: "android_app",
      package_name: "build.raft.app",
      sha256_cert_fingerprints: [
        "B4:91:93:81:D8:F9:CE:DE:4F:8E:B8:F6:D1:32:F6:DF:E0:D6:D1:5B:F6:D1:F6:30:57:D5:EB:A0:45:16:1A:45",
        "5F:08:BB:E8:2A:27:CC:DA:D2:6C:13:52:3A:60:B5:67:0D:3A:A7:63:3E:8E:D2:FD:71:FA:6B:57:51:F9:B0:B1",
      ],
    },
  },
];

const APPLE_APP_SITE_ASSOCIATION = {
  applinks: {
    details: [
      {
        appIDs: ["XDAPXFY8FZ.build.raft.app"],
        components: [{ "/": "/download", comment: "mobile download entry only" }],
      },
    ],
  },
};

function associationResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      // Short, not immutable: rotating a signing cert or adding a path must
      // take effect without waiting out a long cache.
      "Cache-Control": "public, max-age=300",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function associationFileResponse(request) {
  const { pathname } = new URL(request.url);
  if (pathname === WELL_KNOWN_ASSETLINKS_PATH) return associationResponse(ANDROID_ASSETLINKS);
  if (pathname === WELL_KNOWN_AASA_PATH) return associationResponse(APPLE_APP_SITE_ASSOCIATION);
  return null;
}

function unavailableWellKnownResponse() {
  return new Response(null, {
    status: 404,
    statusText: "Not Found",
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function wellKnownResponse(request) {
  const { pathname } = new URL(request.url);
  const association = associationFileResponse(request);
  if (association) return association;

  if (pathname === WELL_KNOWN_CHANGE_PASSWORD_PATH) {
    return new Response(null, {
      status: 302,
      headers: {
        Location: new URL(CHANGE_PASSWORD_INTENT_PATH, request.url).toString(),
        "Cache-Control": "no-store",
      },
    });
  }

  if (pathname === "/.well-known" || pathname.startsWith(WELL_KNOWN_PREFIX)) {
    return unavailableWellKnownResponse();
  }
  return null;
}

function withSecurityHeaders(response) {
  const headers = new Headers(response.headers);
  headers.set("Content-Security-Policy", "base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval' https://challenges.cloudflare.com https://static.cloudflareinsights.com; worker-src 'self' blob:");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export default {
  async fetch(request, env) {
    // Before touching static assets: owned well-known paths must return their
    // exact response, and every other well-known path must be a real 404. A
    // Pages SPA fallback answers 200 text/html for missing routes; Chrome treats
    // that as an unreliable change-password URL and ignores our redirect.
    const wellKnown = wellKnownResponse(request);
    if (wellKnown) return withSecurityHeaders(wellKnown);

    const response = await env.ASSETS.fetch(request);
    const manifestResponse = await normalizeDesktopManifestResponse(request, response);
    return withSecurityHeaders(normalizeBuiltAssetResponse(request, manifestResponse));
  },
};
