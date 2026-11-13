import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

/**
 * Reads and validates the revision ledger (revisions.json) and returns the
 * current contract revision. Throws on any rule violation, including a source
 * digest that the ledger does not record as its last entry: a tsp edit cannot
 * land without classifying it.
 */
export async function readContractRevision({ ledgerPath = resolve(root, "revisions.json"), sourcePath = resolve(root, "activity-sync.tsp") } = {}) {
  const ledgerFile = JSON.parse(await readFile(ledgerPath, "utf8"));
  if (ledgerFile.contract !== "raft.activity-sync") throw new Error("revisions.json: contract must be raft.activity-sync");
  const ledger = ledgerFile.ledger;
  if (!Array.isArray(ledger) || ledger.length === 0) throw new Error("revisions.json: ledger must be a non-empty array");

  const seen = new Set();
  ledger.forEach((entry, index) => {
    const where = `revisions.json ledger[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`${where}: must be an object`);
    if (!Number.isInteger(entry.revision) || entry.revision < 1) throw new Error(`${where}: revision must be a positive integer`);
    if (typeof entry.sourceSha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sourceSha256)) {
      throw new Error(`${where}: sourceSha256 must be a lowercase sha256 hex digest`);
    }
    if (seen.has(entry.sourceSha256)) {
      throw new Error(
        `${where}: sourceSha256 already recorded earlier in the ledger (each digest maps to one revision; ` +
          "to revert to an earlier source, change a comment so the digest is new and classify it)",
      );
    }
    seen.add(entry.sourceSha256);
    if (index === 0) {
      if (entry.revision !== 2) throw new Error(`${where}: the baseline entry is revision 2 (revision 1 is the untracked pre-ledger shape)`);
      if (typeof entry.change !== "string" || !entry.change.trim()) throw new Error(`${where}: the first entry needs a change description`);
      return;
    }
    const previous = ledger[index - 1].revision;
    const compatible = typeof entry.compatible === "string" ? entry.compatible.trim() : "";
    if (entry.revision === previous) {
      if (!compatible) throw new Error(`${where}: same revision as the previous entry requires a non-empty "compatible" reason`);
    } else if (entry.revision === previous + 1) {
      if ("compatible" in entry) throw new Error(`${where}: a new revision is an incompatible change and must not carry "compatible"`);
      if (typeof entry.change !== "string" || !entry.change.trim()) throw new Error(`${where}: an incompatible change needs a "change" description`);
    } else {
      throw new Error(`${where}: revision must equal the previous one (compatible) or previous + 1 (incompatible)`);
    }
  });

  const current = ledger[ledger.length - 1];
  const sourceSha256 = createHash("sha256").update(await readFile(sourcePath)).digest("hex");
  if (current.sourceSha256 !== sourceSha256) {
    throw new Error(
      `revisions.json: activity-sync.tsp is ${sourceSha256}, but the last ledger entry records ${current.sourceSha256}. ` +
        "Append an entry: revision + 1 for an incompatible change, or the same revision with a \"compatible\" reason.",
    );
  }
  return { contract: ledgerFile.contract, revision: current.revision, sourceSha256 };
}

/**
 * The ledger is append-only: the base branch's entries must be an unchanged
 * prefix of the head's. Without this, rewriting the last entry's digest in
 * place (instead of appending) would pass every other check.
 */
export function assertLedgerExtends(baseLedgerFile: { ledger?: unknown[] } | null | undefined, headLedgerFile: { ledger?: unknown[] } | null | undefined) {
  const base = baseLedgerFile?.ledger ?? [];
  const head = headLedgerFile?.ledger ?? [];
  if (head.length < base.length) throw new Error("revisions.json: entries were removed; the ledger is append-only");
  base.forEach((entry, index) => {
    if (JSON.stringify(entry) !== JSON.stringify(head[index])) {
      throw new Error(`revisions.json ledger[${index}]: an existing entry was changed; append a new entry instead`);
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { contract, revision } = await readContractRevision();
  console.log(`activity contract revision ledger: PASS (${contract} revision ${revision})`);
}
