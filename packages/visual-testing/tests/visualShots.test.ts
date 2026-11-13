import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_SHOTS,
  ShotsRequestError,
  buildShotsIndex,
  extractShotsBlock,
  parseShotsRequest,
  planShots,
  renderShotsSummary,
} from "../src/visual-shots.mjs";

// A small manifest with the shapes sharedCases.json uses.
const manifest = {
  cases: [
    { id: "components.ui.button.states", reactPathHint: "packages/web/src/components/ui/Button.tsx" },
    { id: "screens.home.channel-list", reactPathHint: "packages/web/src/features/sidebar/Sidebar.tsx packages/web/src/components/layout/MainLayout.tsx#MobileTabBar" },
    { id: "components.thread.header.states", reactPathHint: "packages/web/src/features/channel/ChatPanel.tsx#PanelHeader" },
    { id: "screens.auth.login", baselineStatus: "pending", reactPathHint: "packages/web/src/components/auth/LoginPage.tsx" },
    { id: "components.tokens.palette", skip: { reason: "hidden" } },
  ],
};

const fence = (json: string) => `Intro text.\n\n\`\`\`visual-shots\n${json}\n\`\`\`\n\nMore text.`;

function rejects(body: string, pattern: RegExp) {
  assert.throws(
    () => planShots({ body, manifest }),
    (error: unknown) => error instanceof ShotsRequestError && pattern.test(error.message),
    `expected a ShotsRequestError matching ${pattern}`,
  );
}

test("a valid block yields its routes (with defaults) and cases", () => {
  const plan = planShots({
    body: fence(JSON.stringify({
      routes: [
        { path: "/s/dev/channel/general", viewport: "390x844", theme: "dark" },
        { path: "/" },
      ],
      cases: ["components.ui.button.states"],
    })),
    manifest,
  });
  assert.equal(plan.source, "pr-description");
  assert.deepEqual(plan.cases, ["components.ui.button.states"]);
  assert.deepEqual(plan.routes, [
    {
      id: "route-01",
      path: "/s/dev/channel/general",
      viewport: { width: 390, height: 844 },
      theme: "dark",
      file: "routes/route-01-s-dev-channel-general-390x844-dark.png",
    },
    { id: "route-02", path: "/", viewport: { width: 390, height: 844 }, theme: "light", file: "routes/route-02-root-390x844-light.png" },
  ]);
});

test("the block is found with CRLF line endings and indented fences", () => {
  const body = "Why\r\n\r\n   ```visual-shots\r\n{\"routes\":[{\"path\":\"/\"}]}\r\n   ```\r\n";
  assert.equal(extractShotsBlock(body), "{\"routes\":[{\"path\":\"/\"}]}");
});

test("no fenced block (none at all, another language, or only an inline mention): null, nothing to shoot", () => {
  for (const body of ["", null, "No block here.", "```json\n{}\n```", "Use a ```visual-shots block, see the README."]) {
    assert.equal(planShots({ body: body as string, manifest }), null);
  }
});

test("an empty block is an error, not a fallback selection", () => {
  rejects(fence("{}"), /requests no shots/);
  rejects(fence(JSON.stringify({ routes: [], cases: [] })), /requests no shots/);
});

test("malformed JSON names the problem", () => {
  rejects(fence("{\"routes\": [}"), /not valid JSON/);
  rejects(fence("[]"), /must be a JSON object/);
  rejects(fence("null"), /must be a JSON object/);
});

test("fence problems are errors, not a silent fallback", () => {
  rejects("```visual-shots\n{\"cases\":[]}\n", /not closed/);
  rejects(`${fence("{\"routes\":[{\"path\":\"/\"}]}")}\n${fence("{\"routes\":[{\"path\":\"/\"}]}")}`, /more than one/);
  rejects("```visual-shots json\n{}\n```", /must be exactly/);
});

test("unknown keys are rejected at the top level and in a route", () => {
  rejects(fence(JSON.stringify({ routes: [{ path: "/" }], secrets: true })), /visual-shots: unknown key "secrets"/);
  rejects(fence(JSON.stringify({ routes: [{ path: "/", headers: { a: 1 } }] })), /routes\[0\]: unknown key "headers"/);
});

test("bad paths are rejected", () => {
  const route = (path: unknown) => fence(JSON.stringify({ routes: [{ path }] }));
  rejects(route("login"), /must start with "\/"/);
  rejects(route("https://example.com/"), /must start with "\/"/);
  rejects(route("//example.com/x"), /must not start with "\/\/"/);
  rejects(route("/a b"), /characters outside/);
  rejects(route("/\\example.com"), /characters outside/);
  rejects(route("/`x`|y"), /characters outside/);
  rejects(route(`/${"a".repeat(200)}`), /the limit is 200/);
  rejects(route(42), /"path" is required/);
  rejects(fence(JSON.stringify({ routes: [{ viewport: "390x844" }] })), /"path" is required/);
});

test("viewport must be WxH within limits; theme must be light or dark", () => {
  const route = (extra: object) => fence(JSON.stringify({ routes: [{ path: "/", ...extra }] }));
  rejects(route({ viewport: "390" }), /must be WIDTHxHEIGHT/);
  rejects(route({ viewport: "390X844" }), /must be WIDTHxHEIGHT/);
  rejects(route({ viewport: 390 }), /must be a string/);
  rejects(route({ viewport: "319x844" }), /width 319 is outside 320-1920/);
  rejects(route({ viewport: "1921x844" }), /width 1921 is outside 320-1920/);
  rejects(route({ viewport: "390x319" }), /height 319 is outside 320-2160/);
  rejects(route({ viewport: "390x2161" }), /height 2161 is outside 320-2160/);
  rejects(route({ theme: "sepia" }), /must be "light" or "dark"/);
  const edges = planShots({ body: route({ viewport: "1920x2160" }), manifest });
  assert.deepEqual(edges.routes[0].viewport, { width: 1920, height: 2160 });
  const low = planShots({ body: route({ viewport: "320x320" }), manifest });
  assert.deepEqual(low.routes[0].viewport, { width: 320, height: 320 });
});

test("too many shots and no shots are rejected", () => {
  const routes = Array.from({ length: MAX_SHOTS }, () => ({ path: "/" }));
  assert.equal(parseShotsRequest(JSON.stringify({ routes }), manifest).routes.length, MAX_SHOTS);
  rejects(fence(JSON.stringify({ routes, cases: ["components.ui.button.states"] })), /requests 21 shots; the limit is 20/);
  rejects(fence(JSON.stringify({ routes: {} })), /"routes" must be an array/);
});

test("cases must be known, capturable and listed once", () => {
  const cases = (ids: unknown[]) => fence(JSON.stringify({ cases: ids }));
  rejects(cases(["shortcut-help-panel"]), /unknown case "shortcut-help-panel"/);
  rejects(cases(["screens.auth.login"]), /is pending/);
  rejects(cases(["components.tokens.palette"]), /is skipped/);
  rejects(cases(["components.ui.button.states", "components.ui.button.states"]), /listed twice/);
  rejects(cases([7]), /must be a case id string/);
});

test("the index marks each planned shot captured or missing, and the summary lists every shot", () => {
  const plan = planShots({
    body: fence(JSON.stringify({ routes: [{ path: "/", theme: "dark" }], cases: ["components.ui.button.states"] })),
    manifest,
  });
  const index = buildShotsIndex(plan, { exists: (file: string) => file.startsWith("routes/"), pr: 12, sha: "abc" });
  assert.deepEqual(index.shots.map((shot: { id: string; status: string }) => `${shot.id} ${shot.status}`), [
    "route-01 captured",
    "components.ui.button.states missing",
  ]);
  const summary = renderShotsSummary(index, "visual-shots-pr-12");
  assert.match(summary, /1\/2 captured/);
  assert.match(summary, /\| route-01 \| route `\/` \| 390x844 \| dark \|/);
  assert.match(summary, /--name visual-shots-pr-12/);
});
