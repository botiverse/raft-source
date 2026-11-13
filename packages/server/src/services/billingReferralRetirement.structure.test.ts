import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const serverRoot = resolve(import.meta.dirname, "../..");
const repoRoot = resolve(serverRoot, "../..");
const names = [
  "billing_paid_history_coverage", "billing_paid_identity_events", "billing_paid_identity_resolutions",
  "referral_discount_campaigns", "referral_discount_codes", "referral_discount_redemptions",
  "referral_discount_provider_operations", "referral_discount_provider_events",
  "referral_discount_financial_adjustments", "referral_discount_financial_adjustment_resolutions",
];
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "__fixtures__" ? [] : sourceFiles(file);
    return /\.[cm]?[jt]sx?$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name) ? [file] : [];
  });
}

test("runtime has no referral ledger imports, SQL, configuration or retired preview route", () => {
  const forbidden = /referralDiscountService|referral_discount_|billing_paid_identity_|billing_paid_history_coverage|REFERRAL_DISCOUNT_|retained-referral-schema|referral-discount\/preview/;
  const files = readdirSync(join(repoRoot, "packages"), { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => join(repoRoot, "packages", entry.name, "src"))
    .filter(existsSync)
    .flatMap(sourceFiles);
  const hits = files.filter(file => forbidden.test(readFileSync(file, "utf8")));
  expect(hits).toEqual([]);
});

// Snapshots before 0462 are pruned (drizzle-kit generate reads only the
// latest; migrate reads only SQL and the journal), so the applied SQL and
// journal entries carry this contract.
test("applied SQL and journal entries remain immutable while later migrations may append", () => {
  const hashes = {
    "0332_dashing_martin_li.sql": "3c00a58c29200e8aea178417b7a7be0a485ee882077ab20d397093c0a67c7256",
    "0335_nervous_lady_vermin.sql": "345fa4e896dd596c8bdf6d10b548c4481c60be7273247c599002a84cf9dd0132",
  };
  for (const [file, digest] of Object.entries(hashes)) {
    expect(createHash("sha256").update(readFileSync(join(serverRoot, "drizzle", file))).digest("hex")).toBe(digest);
  }
  const journal = JSON.parse(readFileSync(join(serverRoot, "drizzle/meta/_journal.json"), "utf8")) as {
    entries: Array<{ idx: number; version: string; when: number; tag: string; breakpoints: boolean }>;
  };
  expect(journal.entries.find(entry => entry.idx === 332)).toEqual({ idx:332, version:"7", when:1791565676510, tag:"0332_dashing_martin_li", breakpoints:true });
  expect(journal.entries.find(entry => entry.idx === 335)).toEqual({ idx:335, version:"7", when:1791772113400, tag:"0335_nervous_lady_vermin", breakpoints:true });
});

test("forward migration drops exactly the retired tables without cascading", () => {
  const migration = readFileSync(join(serverRoot, "drizzle/0336_retire_unused_referral_ledger.sql"), "utf8");
  const targets = [...migration.matchAll(/DROP TABLE public\."([^"]+)" RESTRICT;/g)].map(match => match[1]);
  expect(targets.sort()).toEqual([...names].sort());
  expect(migration).not.toMatch(/\bCASCADE\b|IF EXISTS|RAISE EXCEPTION/);
  expect(existsSync(join(serverRoot, "drizzle/retained-referral-schema.ts"))).toBe(false);
});

test("the latest snapshot has none of the ten retired tables", () => {
  const journal = JSON.parse(readFileSync(join(serverRoot, "drizzle/meta/_journal.json"), "utf8")) as { entries: Array<{ idx: number }> };
  const last = String(journal.entries.at(-1)!.idx).padStart(4, "0");
  const latest = JSON.parse(readFileSync(join(serverRoot, `drizzle/meta/${last}_snapshot.json`), "utf8"));
  expect(names.filter(name => `public.${name}` in latest.tables)).toEqual([]);
});

test("actual Drizzle generation has zero migration drift", () => {
  const run = spawnSync(process.execPath, ["--import", "@oxc-node/core/register", join(serverRoot, "scripts/check-referral-retirement-migrations.ts")], { cwd: serverRoot, encoding: "utf8", timeout: 35000 });
  expect(run.status, run.stdout + run.stderr).toBe(0);
  expect(run.stdout).toContain("zero schema/migration diff");
}, 40000);
