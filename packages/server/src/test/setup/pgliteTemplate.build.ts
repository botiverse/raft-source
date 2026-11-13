// Child process of pgliteTemplate.global.ts: migrate a fresh in-memory PGlite,
// dump its datadir, and publish it atomically at argv[2]. Runs out of the
// Vitest process so the migration memory peak is released on exit.
import { open, rename, mkdir } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { migratePglite } from "../../db/pgliteMigrations";

const out = process.argv[2];
if (!out) throw new Error("usage: pgliteTemplate.build.ts <output .tar>");

const client = new PGlite();
await migratePglite(client);
const dump = await client.dumpDataDir("none");
await client.close();

await mkdir(path.dirname(out), { recursive: true });
const tmp = `${out}.${process.pid}.tmp`;
const file = await open(tmp, "w");
try {
  await file.writeFile(Buffer.from(await dump.arrayBuffer()));
  await file.sync();
} finally {
  await file.close();
}
await rename(tmp, out);
const dir = await open(path.dirname(out), "r");
try {
  await dir.sync();
} finally {
  await dir.close();
}
