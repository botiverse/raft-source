#!/usr/bin/env node
// CI wrapper for visual-shots.mjs, run by the pull_request path of
// .github/workflows/visual-browser.yml.
//
//   plan      --out <plan.json>
//             reads the PR description from VISUAL_SHOTS_PR_BODY (env, never
//             interpolated into a script), writes the plan and, under Actions,
//             the step outputs skip, case_ids and route_count. A description
//             that only mentions the fence inline (no block) gives skip=true.
//   summarize --plan <plan.json> --results <dir> --artifact <name>
//             writes <dir>/index.json and the job summary.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ShotsRequestError, buildShotsIndex, planShots, renderShotsSummary } from "./visual-shots.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function option(args, name) {
  const at = args.indexOf(`--${name}`);
  if (at === -1 || !args[at + 1]) throw new Error(`missing --${name}`);
  return args[at + 1];
}

function appendIfSet(variable, text) {
  if (process.env[variable]) appendFileSync(process.env[variable], text);
}

function plan(args) {
  const manifest = JSON.parse(readFileSync(resolve(packageRoot, "shared/sharedCases.json"), "utf8"));
  const out = option(args, "out");
  let result;
  try {
    result = planShots({ body: process.env.VISUAL_SHOTS_PR_BODY ?? "", manifest });
  } catch (error) {
    if (!(error instanceof ShotsRequestError)) throw error;
    // One line: text quoted from the PR description must not start a new
    // workflow-command line.
    const message = error.message.replace(/[\r\n]+/g, " ");
    console.log(`::error title=visual-shots request::${message}`);
    appendIfSet("GITHUB_STEP_SUMMARY", `## Visual shots: invalid request\n\n${message}\n\nSee packages/visual-testing/README.md (PR screenshots).\n`);
    process.exit(1);
  }
  if (result === null) {
    console.log("visual-shots: the description mentions ```visual-shots but has no fenced block on its own lines; nothing to shoot");
    appendIfSet("GITHUB_OUTPUT", "skip=true\n");
    return;
  }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`visual-shots: ${result.routes.length} route(s), ${result.cases.length} case(s) from ${result.source}`);
  for (const note of result.notes) console.log(`visual-shots: ${note}`);
  appendIfSet("GITHUB_OUTPUT", `skip=false\ncase_ids=${result.cases.join(",")}\nroute_count=${result.routes.length}\n`);
}

function summarize(args) {
  const shotsPlan = JSON.parse(readFileSync(option(args, "plan"), "utf8"));
  const results = option(args, "results");
  const artifact = option(args, "artifact");
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = process.env;
  const index = buildShotsIndex(shotsPlan, {
    exists: (file) => existsSync(resolve(results, file)),
    pr: process.env.VISUAL_SHOTS_PR_NUMBER ? Number(process.env.VISUAL_SHOTS_PR_NUMBER) : null,
    sha: process.env.VISUAL_SHOTS_HEAD_SHA || null,
    runUrl: GITHUB_RUN_ID ? `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}` : null,
  });
  mkdirSync(results, { recursive: true });
  writeFileSync(resolve(results, "index.json"), `${JSON.stringify(index, null, 2)}\n`);
  const summary = renderShotsSummary(index, artifact).replace("<run-url>", index.runUrl ?? "<run-url>");
  appendIfSet("GITHUB_STEP_SUMMARY", summary);
  console.log(summary);
}

const [command, ...args] = process.argv.slice(2);
if (command === "plan") plan(args);
else if (command === "summarize") summarize(args);
else {
  console.error("usage: visual-shots-cli.mjs plan --out <plan.json>\n"
    + "       visual-shots-cli.mjs summarize --plan <plan.json> --results <dir> --artifact <name>");
  process.exit(2);
}
