// Redaction comparison: nothing a base ref masked may become visible.
//
// For every input of the corpus (corpus.ts, the shared credential samples and
// every string literal of the redaction tests, each also behind a literal `\n`,
// inside other text and JSON-encoded), each surface's output at HEAD is
// compared with its output at each `--base` ref. A word of the input that the
// base hid and HEAD shows is reported, unless it is a label kept on purpose
// (a key name before `:`/`=`, a flag, a scheme) or listed in
// INTENDED_UNMASKED below. Exit code 1 when anything else is reported.
//
// Run from the repository root (see README.md):
//   node --import @oxc-node/core/register packages/shared/src/test/diagnosticRedactionCompare/compare.ts --base origin/staging [--base <sha> ...] [--min-word 3]
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as current from "../../diagnosticRedaction";
import { scrubRuntimeErrorText } from "../../runtimeErrorVisibility";
import { DIAGNOSTIC_REDACTION_CREDENTIAL_SAMPLES } from "../diagnosticRedactionCredentialSamples";
import { COMPARISON_CORPUS } from "./corpus";

/** Words HEAD shows on purpose though an earlier ref hid them (#14933 review), with why. */
export const INTENDED_UNMASKED: Readonly<Record<string, string>> = {
  required: "prose after `Authorization:`",
  denied: "prose after `Authorization:`",
  none: "prose after `Authorization=`",
  login: "prose after `auth:`",
  refresh: "prose after `oauth:`",
  flag: "a plain word after a secret flag (`missing --token flag`)",
  hunter: "a plain word after a secret flag (`--password hunter`)",
  after: "a plain word after a secret flag",
  true: "JSON literal after a secret name",
  false: "JSON literal after a secret name",
  null: "JSON literal after a secret name",
  url_credentials: "the text of a `«redacted:url_credentials»` marker in an already redacted input, no longer read as a password (#14963)",
};
// In-word lookalikes of Raft keys (`disk_usage_bytes` read as `sk_usage_bytes`).
const INTENDED_UNMASKED_PATTERN = /(^|n)(disk_usage_\w+|task_sk_test_1|task_list_x|whatsap_x)$/;
// A URL-encoded mask (`%5BREDACTED_PASSWORD%5D`) in an already redacted input:
// runtime error text no longer rereads it as an email's local part (#14963).
const INTENDED_MASK_TEXT = /^5BREDACTED_[A-Z]+$/;
// The host of a connection string whose password is now masked on its own
// (`mongodb+srv://u:***@cluster0.example.net`): the identity rule used to hide it
// only because it read `password@host.tld` as an email address. Only the
// URL's real host counts: the word must follow the last `@` of the authority
// and end it (followed by `/`, `:`, `?`, `#`, whitespace, a quote or the end). The
// password may hold a `/` before its first `@`, and `@`-separated parts after
// it without `/`, `?` or `#` (#14963), so `u:pw@db/x?to=alice@corp.example.com`
// does not make `corp.example.com` a host. Nor does an address the base masked
// as an email whose local part starts outside the authority (`,alice@…`).
const AUTHORITY_PASSWORD = String.raw`[^\s@?#"'<>]+(?:@[^\s@/?#"'<>]*)*`;
const intendedHost = (word: string, input: string) =>
  /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+(\/\w*)?$/.test(word) &&
  new RegExp(`[a-z][a-z0-9+.-]*://[^\\s@:/?#"'<>]*:${AUTHORITY_PASSWORD}@${escapeRe(word)}(?=[/:?#\\s"'<>]|$)`, "i").test(input) &&
  !new RegExp(`(?:^|[?#&=,;\\s"'<>])[A-Za-z0-9._%+-]+@${escapeRe(word)}`).test(input);

type Surface = (text: string) => string;
interface Surfaces { runtime: Surface; diag: Surface; counted: Surface; credentials: Surface }

const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const args = process.argv.slice(2);
const bases: string[] = [];
let minWord = 3;
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "--base") bases.push(args[++i]!);
  else if (args[i] === "--min-word") minWord = Number(args[++i]);
}
if (bases.length === 0) bases.push("origin/staging");

// Before #14933, `raft-computer logs` / `doctor` masked with these three rules.
const LEGACY_REDACT_SECRETS: Surface = (line) =>
  [/sk_[a-z]+_[A-Za-z0-9._-]+/g, /\beyJ[A-Za-z0-9._-]{20,}/g, /\b[A-Fa-f0-9]{40,}\b/g].reduce((out, re) => out.replace(re, "***REDACTED***"), line);

async function surfacesAt(ref: string, dir: string): Promise<Surfaces> {
  const archive = execFileSync("git", ["-C", repoRoot, "archive", ref, "packages/shared/src"], { maxBuffer: 1 << 30 });
  execFileSync("tar", ["-x", "-C", dir], { input: archive, maxBuffer: 1 << 30 });
  const src = path.join(dir, "packages/shared/src");
  const d = await import(pathToFileURL(path.join(src, "diagnosticRedaction.ts")).href);
  const r = await import(pathToFileURL(path.join(src, "runtimeErrorVisibility.ts")).href);
  return {
    runtime: r.scrubRuntimeErrorText,
    diag: (s) => d.redactDiagnosticText(s),
    counted: (s) => d.redactDiagnosticSecrets(s).text,
    credentials: d.redactDiagnosticCredentials ? (s) => d.redactDiagnosticCredentials(s, { mask: "***REDACTED***" }) : LEGACY_REDACT_SECRETS,
  };
}

const head: Surfaces = {
  runtime: scrubRuntimeErrorText,
  diag: (s) => current.redactDiagnosticText(s),
  counted: (s) => current.redactDiagnosticSecrets(s).text,
  credentials: (s) => current.redactDiagnosticCredentials(s, { mask: "***REDACTED***" }),
};

function buildCorpus(): Set<string> {
  const corpus = new Set<string>([...COMPARISON_CORPUS, ...DIAGNOSTIC_REDACTION_CREDENTIAL_SAMPLES.map((s) => s.sample)]);
  for (const file of [
    "packages/shared/src/diagnosticRedaction.test.ts",
    "packages/shared/src/runtimeErrorVisibility.test.ts",
    "packages/daemon/src/runtimeErrorDiagnostics.test.ts",
    "packages/computer/src/doctor.test.ts",
  ]) {
    const source = readFileSync(path.join(repoRoot, file), "utf8");
    for (const m of source.matchAll(/"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\$\n])*`|String\.raw`[^`$\n]*`/g)) {
      let value: unknown;
      try {
        value = new Function(`return ${m[0]}`)();
      } catch {
        continue;
      }
      if (typeof value === "string" && value.length >= 6) corpus.add(value);
    }
  }
  for (const input of [...corpus]) {
    corpus.add(`\\n${input}`);
    corpus.add(`x ${input} y`);
    corpus.add(JSON.stringify(input));
  }
  return corpus;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const isLabel = (input: string, word: string) =>
  new RegExp(`${escapeRe(word)}[\\\\"']*\\s*[:=]`).test(input) || /^-/.test(word) || /^(Basic|Bearer|Authorization|Token)$/i.test(word);

const corpus = buildCorpus();
const wordRe = new RegExp(`[A-Za-z0-9+/._-]{${minWord},}`, "g");
let unexpected = 0;
let intended = 0;
for (const ref of bases) {
  const dir = mkdtempSync(path.join(tmpdir(), "redaction-compare-"));
  try {
    const base = await surfacesAt(ref, dir);
    for (const input of corpus) {
      for (const name of Object.keys(head) as (keyof Surfaces)[]) {
        const now = head[name](input);
        const before = base[name](input);
        for (const word of new Set(input.match(wordRe) ?? [])) {
          if (isLabel(input, word) || before.includes(word) || !now.includes(word)) continue;
          if (word in INTENDED_UNMASKED || INTENDED_UNMASKED_PATTERN.test(word) || INTENDED_MASK_TEXT.test(word) || intendedHost(word, input)) {
            intended += 1;
            continue;
          }
          unexpected += 1;
          console.log(`[${name} vs ${ref}] ${JSON.stringify(word)} visible in ${JSON.stringify(input).slice(0, 120)}\n   now:    ${JSON.stringify(now).slice(0, 160)}\n   before: ${JSON.stringify(before).slice(0, 160)}`);
        }
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
console.log(`redaction comparison: ${corpus.size} inputs x 4 surfaces vs ${bases.join(", ")}: ${unexpected} newly visible, ${intended} intended`);
process.exit(unexpected === 0 ? 0 : 1);
