// Agent API for a version's publish check (task #proj-workspace:#130;
// docs/development/workspace-artifacts.md, "Publish check"): after an agent
// pushes an HTML version (not Markdown, nor PDF for now), Raft opens it in a
// headless browser and keeps a desktop and a phone screenshot and what the
// page got wrong. The push answers its version's check (the one it recorded;
// a replay, that check as it is now: agentApiArtifactPushCheckSchema, in
// agentApiArtifactsContract.ts beside the push's answer); these are the
// reads, declared in apps/artifacts/agentApi.ts (artifactCheck's params are
// agentApiArtifactParamsSchema, as every route on one Artifact):
//
// - artifactCheck, `GET /artifacts/:artifact/check?version=`: the version's
//   check (default the current version's), or `check: null` when it has none
//   (a kind no check opens, a version pushed before checks, or a server
//   that runs no publish checks: one deployed without the check Worker).
// - artifactCheckShot, `GET /artifacts/:artifact/check/:shot?version=`: one
//   of its screenshots, a PNG, for a check that is `done` and lists it in
//   `screenshots` (only the newest three checked versions of an Artifact keep
//   theirs).
//
// Both need an Artifact the caller sees from inside (its server's agents, or
// its joint channel's): another server's agent reading a public Artifact
// reads its current version only, never its checks (404 NOT_VISIBLE, as
// core's object file route answers it). Additive only: a field is added,
// never renamed or removed.
import { z } from "zod";
import { lazySchema } from "./lazySchema";
import { ARTIFACT_CHECK_SHOTS } from "./webArtifactsContract";

const passthroughObject = <T extends z.ZodRawShape>(shape: T) => z.object(shape).passthrough();

/**
 * A check's state: `pending` when the push recorded it, `running` while the
 * check Worker has the version open, then `done` or `failed`; `skipped` when
 * it never runs (`skipReason`).
 */
export const AGENT_API_ARTIFACT_CHECK_STATUSES = ["pending", "running", "done", "failed", "skipped"] as const;
export type AgentApiArtifactCheckStatus = (typeof AGENT_API_ARTIFACT_CHECK_STATUSES)[number];

export const agentApiArtifactCheckQuerySchema = lazySchema("agentApiArtifactCheckQuerySchema", () => passthroughObject({
  /** A version number; default the current version. */
  version: z.string().regex(/^[1-9]\d{0,8}$/).optional(),
}));

export const agentApiArtifactCheckShotParamsSchema = lazySchema("agentApiArtifactCheckShotParamsSchema", () => passthroughObject({
  artifact: z.string().trim().min(1),
  /** Which screenshot: `desktop` (1280×800) or `phone` (390×844 at 2x). */
  shot: z.enum(ARTIFACT_CHECK_SHOTS),
}));

/** What a finished (`done`) check found on the page, as stored (each list already cut to its cap). */
export const agentApiArtifactCheckFindingsSchema = lazySchema("agentApiArtifactCheckFindingsSchema", () => passthroughObject({
  /** The page's console errors and uncaught exceptions, in order, at most ten; each text cut to 300 characters. */
  consoleErrors: z.array(passthroughObject({ message: z.string(), source: z.string().nullable(), line: z.number().int().nullable() })),
  /** Resources the page couldn't load (blocked by its policy, refused navigations, network failures), at most twenty. */
  blockedResources: z.array(z.string()),
  /** Hardly any visible text and a uniform desktop screenshot. */
  blank: z.boolean(),
  /** At phone width the page scrolls sideways: its content's width against the screen's. Null when it doesn't. */
  phoneOverflow: passthroughObject({ contentWidth: z.number().int(), viewportWidth: z.number().int() }).nullable(),
}));

export const agentApiArtifactCheckSchema = lazySchema("agentApiArtifactCheckSchema", () => passthroughObject({
  id: z.string(),
  status: z.enum(AGENT_API_ARTIFACT_CHECK_STATUSES),
  /** Exactly when `skipped`: `unchanged` (the files are the previous version's, byte for byte), `server_daily_cap`, `platform_daily_cap`; a string, so a later reason parses too. */
  skipReason: z.string().nullable(),
  /** Exactly when `failed`, code-shaped (`load_timeout`, `load_error:<class>`, `expired`, …), never a message from the page. */
  errorClass: z.string().nullable(),
  /** Only on a `done` check. */
  findings: agentApiArtifactCheckFindingsSchema.nullable(),
  createdAt: z.string().datetime(),
  /** When it ended or was skipped; null while pending or running. */
  finishedAt: z.string().datetime().nullable(),
  /**
   * The screenshots it kept, each downloaded with artifactCheckShot (the same
   * `artifact` and `version`, its `shot`). Empty unless `done`, and once the
   * Artifact's newer checked versions have taken their place.
   */
  screenshots: z.array(passthroughObject({ shot: z.enum(ARTIFACT_CHECK_SHOTS) })),
}));

export const agentApiArtifactCheckResponseSchema = lazySchema("agentApiArtifactCheckResponseSchema", () => passthroughObject({
  artifact: passthroughObject({ id: z.string(), title: z.string(), currentVersion: z.number().int().nullable() }),
  /** The version read. */
  version: z.number().int(),
  /** Its check, or null when it has none (see the header). */
  check: agentApiArtifactCheckSchema.nullable(),
}));

export type AgentApiArtifactCheckQuery = z.infer<typeof agentApiArtifactCheckQuerySchema>;
export type AgentApiArtifactCheckShotParams = z.infer<typeof agentApiArtifactCheckShotParamsSchema>;
export type AgentApiArtifactCheckFindings = z.infer<typeof agentApiArtifactCheckFindingsSchema>;
export type AgentApiArtifactCheck = z.infer<typeof agentApiArtifactCheckSchema>;
export type AgentApiArtifactCheckResponse = z.infer<typeof agentApiArtifactCheckResponseSchema>;
