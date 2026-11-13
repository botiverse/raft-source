/**
 * The `raft-perf claim` command as a function, so claimCommand.test.ts can run it
 * against files in a temp directory. src/claim.ts is the executable; the rules are in src/claims.ts.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { type ClaimEvent, type ClaimRow, claimStates, isCommitSha, judgeClaim, median, metricRuns, parseClaims, predictionFloor, sameCommit, transitionError } from "./claims";

const HELP = `raft-perf claim <open|ship|verify|withdraw|status> --claims <claims.jsonl> [options]

  open      --id --project --env --title --ref --author --scenario --metric --predicted-delta <n, negative = saves>
            --before <rows.jsonl> --runner <machine> --verify-command <command>
  ship      --id --commit <sha>          the change is deployed at this commit
  verify    --id --before <rows.jsonl> --after <rows.jsonl>
            the before rows must give the baseline the claim was opened with; the after rows must name the shipped commit
  withdraw  --id --note <why>
  status                                 the current state of every claim

  One writer at a time: the file is read, checked and appended to without a lock.
  open, ship, verify and withdraw print the row they wrote as JSON, status prints every claim's state;
  then one line and, when there is one, the next command on stderr.
  Exit 0 = done (verify: verified), 1 = verify said refuted or inconclusive, 2 = error.
`;

class ClaimError extends Error {}
const fail = (message: string): never => {
  throw new ClaimError(message);
};

function readRows(path: string | undefined, flag: string): Record<string, unknown>[] {
  if (!path) fail(`${flag} <rows.jsonl> is required`);
  const text = (() => {
    try {
      return readFileSync(path!, "utf8");
    } catch {
      return fail(`cannot read ${path}`);
    }
  })();
  return text
    .split("\n")
    .filter((line) => line.trim())
    .map((line, i) => {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        fail(`${path} line ${i + 1} is not JSON`);
      }
      if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`${path} line ${i + 1} is not a row (a JSON object)`);
      return value as Record<string, unknown>;
    });
}

export interface ClaimIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

/** Run one `claim` call. Returns the exit code; a ClaimError (bad input, refused transition) is reported on stderr as 2. */
export function runClaim(argv: readonly string[], io: ClaimIo): number {
  try {
    return main(argv, io);
  } catch (error) {
    io.stderr(`raft-perf claim: ${error instanceof ClaimError ? error.message : `failed: ${(error as Error)?.stack ?? String(error)}`}\n`);
    return 2;
  }
}

/** The commit of every row; a row that names none proves nothing about which code was measured, so it is refused. */
function commitsOf(rows: Record<string, unknown>[], flag: string): string[] {
  return rows.map((r) => (isCommitSha(r.commit_sha) ? r.commit_sha : fail(`${flag} has a row that names no commit (commit_sha ${JSON.stringify(r.commit_sha ?? null)}): a claim needs rows tied to the code they measured`)));
}

function main(argv: readonly string[], io: ClaimIo): number {
  if (argv.length === 0) {
    io.stderr(HELP);
    return 2;
  }
  // help is asked for as the command, or as a flag of its own; `--note --help` is a note missing its value, not a request for help
  if (argv[0] === "--help" || argv[0] === "-h") {
    io.stdout(HELP);
    return 0;
  }
  const command = argv[0]!;
  if (command.startsWith("-")) fail(`the command comes first: claim <open|ship|verify|withdraw|status> … (got ${command})`);
  // parseArgs refuses `--predicted-delta -350` (a value that looks like a flag): hand it over as `--predicted-delta=-350`
  const rest = argv.slice(1).flatMap((arg, i, all) => (arg === "--predicted-delta" && /^-[\d.]/.test(all[i + 1] ?? "") ? [`${arg}=${all[i + 1]}`] : all[i - 1] === "--predicted-delta" && /^-[\d.]/.test(arg) ? [] : [arg]));
  const parsed = (() => {
    try {
      return parseArgs({
        args: rest,
        options: {
          claims: { type: "string" },
          id: { type: "string" },
          project: { type: "string" },
          env: { type: "string" },
          title: { type: "string" },
          ref: { type: "string" },
          author: { type: "string" },
          scenario: { type: "string" },
          metric: { type: "string" },
          "predicted-delta": { type: "string" },
          before: { type: "string" },
          after: { type: "string" },
          runner: { type: "string" },
          "verify-command": { type: "string" },
          commit: { type: "string" },
          note: { type: "string" },
          help: { type: "boolean", short: "h", default: false },
        },
      });
    } catch (error) {
      return fail(`${(error as Error).message.split("\n")[0]} (usage: claim <open|ship|verify|withdraw|status> --claims <file> …; --help)`);
    }
  })();
  const args = parsed.values;
  if (args.help) {
    io.stdout(HELP);
    return 0;
  }
  if (!["open", "ship", "verify", "withdraw", "status"].includes(command)) fail(`unknown command ${command}: open, ship, verify, withdraw or status`);
  if (!args.claims) fail("--claims <claims.jsonl> is required");
  const file = args.claims!;
  if (command !== "open" && !existsSync(file)) fail(`no claims file at ${file}`);
  const existing = (() => {
    try {
      return existsSync(file) ? readFileSync(file, "utf8") : "";
    } catch (error) {
      return fail(`cannot read ${file}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`);
    }
  })();
  const rows = (() => {
    try {
      return parseClaims(existing);
    } catch (error) {
      return fail(`${file}: ${(error as Error).message}`);
    }
  })();
  const states = claimStates(rows);
  const say = (line: string, next?: string) => io.stderr(`raft-perf claim: ${line}\n${next ? `next: ${next}\n` : ""}`);

  if (command === "status") {
    io.stdout(`${JSON.stringify({ tool: "raft-perf claim", claims: states }, null, 2)}\n`);
    const count = (e: ClaimEvent) => states.filter((r) => r.event === e).length;
    say(`${states.length} claim(s): ${count("opened")} opened, ${count("shipped")} shipped, ${count("verified")} verified, ${count("refuted")} refuted, ${count("inconclusive")} inconclusive, ${count("withdrawn")} withdrawn`);
    return 0;
  }

  const id = args.id?.trim() || fail("--id <claim id> is required");
  const current = states.find((r) => r.claim_id === id) ?? null;
  const toolVersion: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  const append = (row: ClaimRow) => {
    // the row must read back as a claim row: never write what `parseClaims` would refuse
    try {
      parseClaims(JSON.stringify(row));
    } catch (error) {
      fail((error as Error).message.replace(/^claims line 1: /, ""));
    }
    // a file whose last line has no newline (a hand edit, an export) must not get this row glued onto it
    try {
      appendFileSync(file, `${existing !== "" && !existing.endsWith("\n") ? "\n" : ""}${JSON.stringify(row)}\n`);
    } catch (error) {
      fail(`cannot write ${file}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`);
    }
    io.stdout(`${JSON.stringify({ tool: "raft-perf claim", row }, null, 2)}\n`);
  };
  /** The claim's current row as the base of its next one, after checking that `event` may follow (the three verdicts share one rule). */
  const follow = (event: ClaimEvent): ClaimRow => {
    const error = transitionError(current?.event ?? null, event);
    if (error) fail(`${id}: ${error}`);
    return { ...current!, event, event_at: new Date().toISOString(), tool_version: toolVersion };
  };

  if (command === "open") {
    const error = transitionError(current?.event ?? null, "opened");
    if (error) fail(`${id}: ${error}`);
    const need = (key: "project" | "env" | "title" | "ref" | "author" | "scenario" | "metric" | "runner" | "verify-command") => args[key]?.trim() || fail(`--${key} is required`);
    const metric = need("metric");
    const predicted = Number(args["predicted-delta"]);
    if (!args["predicted-delta"] || !Number.isFinite(predicted) || predicted === 0) fail("--predicted-delta must be a non-zero number (negative = the metric goes down)");
    const beforeRows = readRows(args.before, "--before");
    // the same rows are asked for again at verify, which refuses a row without a commit: refuse it here, not after shipping
    commitsOf(beforeRows, "--before");
    const before = metricRuns(beforeRows, metric);
    if (before.length < 3) fail(`--before has ${before.length} run(s) with ${metric}; a baseline needs at least 3`);
    const baseline = median(before);
    const floor = predictionFloor(metric, baseline);
    append({
      claim_id: id,
      event: "opened",
      event_at: new Date().toISOString(),
      project: need("project"),
      env: need("env"),
      title: need("title"),
      ref: need("ref"),
      author: need("author"),
      scenario: need("scenario"),
      metric,
      predicted_delta: predicted,
      baseline_value: Math.round(baseline * 10) / 10,
      measured_value: null,
      measured_delta: null,
      runs_before: before.length,
      runs_after: null,
      commit_sha: null,
      runner: need("runner"),
      verify_command: need("verify-command"),
      tool_version: toolVersion,
      note: args.note?.trim() || null,
    });
    say(
      `${id} opened: ${metric} is ${Math.round(baseline * 10) / 10} over ${before.length} runs, predicted ${predicted > 0 ? "+" : ""}${predicted}` +
        (Math.abs(predicted) <= 2 * floor ? `; warning: the noise floor here is ${Math.round(floor * 10) / 10}, so a miss could not be told from noise: if no move shows, the verdict will be inconclusive, not refuted` : ""),
      `when it is deployed: claim ship --claims ${file} --id ${id} --commit <sha>`);
    return 0;
  }

  if (command === "ship") {
    if (!isCommitSha(args.commit)) fail("--commit must be a git sha of 7 to 40 hex digits");
    const row = follow("shipped");
    append({ ...row, commit_sha: args.commit!, note: args.note?.trim() || row.note });
    say(`${id} shipped at ${args.commit}`, `measure again on ${row.runner} (${row.verify_command}), then: claim verify --claims ${file} --id ${id} --before <rows.jsonl> --after <rows-after.jsonl>`);
    return 0;
  }

  if (command === "withdraw") {
    const note = args.note?.trim() || fail("--note <why> is required");
    append({ ...follow("withdrawn"), note });
    say(`${id} withdrawn`);
    return 0;
  }

  // verify
  const shipped = follow("verified");
  const beforeRows = readRows(args.before, "--before");
  const before = metricRuns(beforeRows, shipped.metric);
  const afterRows = readRows(args.after, "--after");
  const after = metricRuns(afterRows, shipped.metric);
  // rows carry the page's full sha, a person types a short one
  if (!isCommitSha(shipped.commit_sha)) fail(`${id}: its shipped row names no commit; the claims file was edited by hand`);
  const afterCommits = [...new Set(commitsOf(afterRows, "--after"))];
  if (!afterCommits.every((c) => sameCommit(c, shipped.commit_sha!))) fail(`--after was not measured on the shipped commit ${shipped.commit_sha} (its rows name ${afterCommits.join(", ")})`);
  if (commitsOf(beforeRows, "--before").some((c) => sameCommit(c, shipped.commit_sha!))) fail(`--before was measured on the shipped commit ${shipped.commit_sha} itself: it must be from before the change`);
  if (before.length !== shipped.runs_before) fail(`--before has ${before.length} run(s) of ${shipped.metric}, the claim was opened with ${shipped.runs_before}: pass the rows it was opened with`);
  let judgement;
  try {
    judgement = judgeClaim(shipped.metric, shipped.predicted_delta, before, after);
  } catch (error) {
    return fail((error as Error).message);
  }
  if (judgement.baseline !== shipped.baseline_value) fail(`--before gives a baseline of ${judgement.baseline}, the claim was opened with ${shipped.baseline_value}: pass the rows it was opened with`);
  append({ ...shipped, event: judgement.event, measured_value: judgement.measured, measured_delta: judgement.measuredDelta, runs_after: after.length, note: `${judgement.reason}; calibration ${judgement.calibration}` });
  say(`${id} ${judgement.event}: ${judgement.reason}; calibration ${judgement.calibration} (1 = as predicted)`, judgement.event === "inconclusive" ? "take more runs on a quiet runner and open a new claim for the same change" : undefined);
  return judgement.event === "verified" ? 0 : 1;
}

