// Screenshots of a PR's pages on demand (a ```visual-shots block in the PR
// description).
//
// Pure functions only: the PR description parser and validator and the
// artifact index. The CLI wrapper is
// visual-shots-cli.mjs; the workflow is .github/workflows/visual-browser.yml;
// tests are tests/visualShots.test.ts. Usage and limits:
// packages/visual-testing/README.md#pr-screenshots-visual-shots-block.

export const MAX_SHOTS = 20;
export const MAX_PATH_LENGTH = 200;
export const VIEWPORT_LIMITS = Object.freeze({ minWidth: 320, maxWidth: 1920, minHeight: 320, maxHeight: 2160 });
export const DEFAULT_VIEWPORT = "390x844";
export const DEFAULT_THEME = "light";
export const THEMES = Object.freeze(["light", "dark"]);

const TOP_LEVEL_KEYS = ["routes", "cases"];
const ROUTE_KEYS = ["path", "viewport", "theme"];
// Path, query and fragment characters only: no whitespace, quotes, backslash,
// angle brackets, pipe or backtick (the job summary quotes paths in code spans).
const PATH_PATTERN = /^\/[A-Za-z0-9._~\-/?=&%#:@+,;]*$/;
const VIEWPORT_PATTERN = /^(\d{1,5})x(\d{1,5})$/;
const FENCE_OPEN = /^ {0,3}```visual-shots(.*)$/;
const FENCE_CLOSE = /^ {0,3}```\s*$/;

export class ShotsRequestError extends Error {
  constructor(message) {
    super(message);
    this.name = "ShotsRequestError";
  }
}

const fail = (message) => {
  throw new ShotsRequestError(message);
};

/**
 * The text inside the PR description's ```visual-shots fenced block, or null
 * when there is none. More than one block, an unclosed block or an info string
 * other than exactly `visual-shots` is an error, not a silent fallback.
 */
export function extractShotsBlock(body) {
  if (typeof body !== "string" || body === "") return null;
  const lines = body.split(/\r?\n/);
  let content = null;
  for (let index = 0; index < lines.length; index += 1) {
    const open = FENCE_OPEN.exec(lines[index]);
    if (!open) continue;
    if (open[1].trim() !== "") {
      fail(`the fence must be exactly \`\`\`visual-shots, found \`\`\`visual-shots${open[1]}`);
    }
    if (content !== null) fail("the PR description has more than one ```visual-shots block; keep one");
    const end = lines.findIndex((line, at) => at > index && FENCE_CLOSE.test(line));
    if (end === -1) fail("the ```visual-shots block is not closed with ```");
    content = lines.slice(index + 1, end).join("\n");
    index = end;
  }
  return content;
}

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function rejectUnknownKeys(value, allowed, where) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    fail(`${where}: unknown key${unknown.length > 1 ? "s" : ""} ${unknown.map((key) => JSON.stringify(key)).join(", ")} (allowed: ${allowed.join(", ")})`);
  }
}

export function validatePath(path, where = "path") {
  if (typeof path !== "string" || path === "") fail(`${where}: "path" is required and must be a string starting with "/"`);
  if (path.length > MAX_PATH_LENGTH) fail(`${where}: path is ${path.length} characters; the limit is ${MAX_PATH_LENGTH}`);
  if (!path.startsWith("/")) fail(`${where}: path ${JSON.stringify(path)} must start with "/" (a path in the app under test, not a URL)`);
  if (path.startsWith("//")) fail(`${where}: path ${JSON.stringify(path)} must not start with "//" (that names another host)`);
  if (!PATH_PATTERN.test(path)) {
    fail(`${where}: path ${JSON.stringify(path)} has characters outside A-Z a-z 0-9 . _ ~ - / ? = & % # : @ + , ;`);
  }
  // Belt and braces: whatever the characters, it must stay on the app's origin.
  const base = "http://app-under-test.invalid";
  if (new URL(path, base).origin !== base) fail(`${where}: path ${JSON.stringify(path)} leaves the app under test`);
  return path;
}

export function parseViewport(value, where = "viewport") {
  if (typeof value !== "string") fail(`${where}: viewport must be a string like "390x844"`);
  const match = VIEWPORT_PATTERN.exec(value);
  if (!match) fail(`${where}: viewport ${JSON.stringify(value)} must be WIDTHxHEIGHT, e.g. "390x844"`);
  const width = Number(match[1]);
  const height = Number(match[2]);
  const { minWidth, maxWidth, minHeight, maxHeight } = VIEWPORT_LIMITS;
  if (width < minWidth || width > maxWidth) fail(`${where}: viewport width ${width} is outside ${minWidth}-${maxWidth}`);
  if (height < minHeight || height > maxHeight) fail(`${where}: viewport height ${height} is outside ${minHeight}-${maxHeight}`);
  return { width, height };
}

function parseTheme(value, where) {
  if (!THEMES.includes(value)) fail(`${where}: theme ${JSON.stringify(value)} must be "light" or "dark"`);
  return value;
}

function isSkipped(visualCase) {
  const value = visualCase.skip;
  if (value === true) return true;
  return Boolean(value && typeof value === "object" && value.enabled !== false);
}

function routeFileName(index, path, viewport, theme) {
  const slug = path.split(/[?#]/)[0].replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "root";
  return `route-${String(index + 1).padStart(2, "0")}-${slug}-${viewport.width}x${viewport.height}-${theme}.png`;
}

function normalizeRoutes(routes) {
  return routes.map((route, index) => ({
    id: `route-${String(index + 1).padStart(2, "0")}`,
    path: route.path,
    viewport: route.viewport,
    theme: route.theme,
    file: `routes/${routeFileName(index, route.path, route.viewport, route.theme)}`,
  }));
}

/**
 * Strictly validate the JSON inside a ```visual-shots block. Throws a
 * ShotsRequestError naming the problem; returns { routes, cases } otherwise.
 */
export function parseShotsRequest(text, manifest) {
  let request;
  try {
    request = JSON.parse(text);
  } catch (error) {
    fail(`the \`\`\`visual-shots block is not valid JSON: ${error.message}`);
  }
  if (!plainObject(request)) fail('the ```visual-shots block must be a JSON object like {"routes":[...],"cases":[...]}');
  rejectUnknownKeys(request, TOP_LEVEL_KEYS, "visual-shots");

  const routes = request.routes ?? [];
  const cases = request.cases ?? [];
  if (!Array.isArray(routes)) fail('"routes" must be an array');
  if (!Array.isArray(cases)) fail('"cases" must be an array of case ids');
  const total = routes.length + cases.length;
  if (total === 0) fail("the ```visual-shots block requests no shots; add routes or cases");
  if (total > MAX_SHOTS) fail(`the \`\`\`visual-shots block requests ${total} shots; the limit is ${MAX_SHOTS}`);

  const parsedRoutes = routes.map((route, index) => {
    const where = `routes[${index}]`;
    if (!plainObject(route)) fail(`${where} must be an object like {"path":"/","viewport":"390x844","theme":"dark"}`);
    rejectUnknownKeys(route, ROUTE_KEYS, where);
    return {
      path: validatePath(route.path, where),
      viewport: parseViewport(route.viewport ?? DEFAULT_VIEWPORT, where),
      theme: parseTheme(route.theme ?? DEFAULT_THEME, where),
    };
  });

  const byId = new Map((manifest?.cases ?? []).map((item) => [item.id, item]));
  const seen = new Set();
  const parsedCases = cases.map((id, index) => {
    const where = `cases[${index}]`;
    if (typeof id !== "string") fail(`${where} must be a case id string`);
    const visualCase = byId.get(id);
    if (!visualCase) fail(`${where}: unknown case ${JSON.stringify(id)} (ids are in packages/visual-testing/shared/sharedCases.json)`);
    if (isSkipped(visualCase)) fail(`${where}: case ${JSON.stringify(id)} is skipped in sharedCases.json and is not captured`);
    if (visualCase.baselineStatus === "pending") fail(`${where}: case ${JSON.stringify(id)} is pending in sharedCases.json and has no working capture`);
    if (seen.has(id)) fail(`${where}: case ${JSON.stringify(id)} is listed twice`);
    seen.add(id);
    return id;
  });

  return { routes: parsedRoutes, cases: parsedCases };
}

/**
 * What to shoot for one PR run: the ```visual-shots block, strictly
 * validated, or null when the description has no such block (it may only
 * mention the fence inline; the workflow's trigger is a plain substring test).
 * There is no fallback selection: an empty block ({}) is an error.
 */
export function planShots({ body, manifest }) {
  const block = extractShotsBlock(body);
  if (block === null) return null;
  const request = parseShotsRequest(block, manifest);
  return { source: "pr-description", notes: [], routes: normalizeRoutes(request.routes), cases: request.cases };
}

/**
 * The artifact's index.json: one entry per planned shot, with its file
 * relative to the artifact root and whether the run produced it.
 */
export function buildShotsIndex(plan, { exists, pr = null, sha = null, runUrl = null } = {}) {
  const shots = [
    ...plan.routes.map((route) => ({
      kind: "route",
      id: route.id,
      path: route.path,
      viewport: `${route.viewport.width}x${route.viewport.height}`,
      theme: route.theme,
      file: route.file,
    })),
    ...plan.cases.map((id) => ({ kind: "case", id, file: `react/${id}.png` })),
  ].map((shot) => ({ ...shot, status: exists(shot.file) ? "captured" : "missing" }));
  return { pr, sha, runUrl, source: plan.source, notes: plan.notes, shots };
}

export function renderShotsSummary(index, artifactName) {
  const captured = index.shots.filter((shot) => shot.status === "captured").length;
  const lines = [
    `## Visual shots${index.pr ? ` for PR #${index.pr}` : ""}`,
    "",
    `${captured}/${index.shots.length} captured. Selected from: ${index.source}. Artifact: \`${artifactName}\`.`,
    ...index.notes.map((note) => `\n> ${note}`),
    "",
    "| Shot | What | Viewport | Theme | File | Status |",
    "| --- | --- | --- | --- | --- | --- |",
    ...index.shots.map((shot) =>
      `| ${shot.id} | ${shot.kind === "route" ? `route \`${shot.path}\`` : "case"} | ${shot.viewport ?? "case default"} | ${shot.theme ?? "case default"} | \`${shot.file}\` | ${shot.status} |`),
    "",
    `Download: \`stamp run download <run-url> --name ${artifactName} --dir ./${artifactName}\``,
    "",
  ];
  return lines.join("\n");
}
