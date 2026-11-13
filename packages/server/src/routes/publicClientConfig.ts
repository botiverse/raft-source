import { Router, type Router as RouterType } from "express";
import { appHosts, artifactsEmbedOrigin } from "../platform/links";
import { isPrivacyModeOn } from "../config/privacyMode";

// Per-deploy client config (#proj-workspace:fbc76200): what every client of this deployment (the
// web at each page load, signed in or not; the mobile App) needs to know about the deployment
// itself. Mounted without auth: credentials on the request are ignored and nothing here is per
// person or per server, so one URL has one answer and can be cached.
//
// Additive only: new deploy config goes here as a new field. A field a released client reads is
// never renamed, retyped or removed.
export const publicClientConfigRouter: RouterType = Router();

publicClientConfigRouter.get("/", (_req, res) => {
  res.setHeader("Cache-Control", "public, max-age=300");
  res.json({
    // Raft's own app hosts (platform/links appHosts(): the canonical host, APP_URL's, Raft's
    // earlier hosts, APP_PERMALINK_HOSTS), as hostnames: a link on one of them names something
    // of Raft's (a message permalink, an Artifact), the hosts the link-card reads leave Raft's own
    // links out on.
    appHosts: appHosts(),
    // RAFT_PRIVACY_MODE (config/privacyMode.ts): the web then sends no telemetry. Present only
    // when on; a client reads a missing field (off, or an older server) as off.
    ...(isPrivacyModeOn() ? { privacyMode: true } : {}),
    // The content Worker's embed host (artifactsEmbedOrigin), or null: the web's Share → Embed.
    artifactsEmbedOrigin: artifactsEmbedOrigin(),
  });
});
