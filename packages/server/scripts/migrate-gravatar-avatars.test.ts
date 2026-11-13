import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { PGlite } from "@electric-sql/pglite";
import sharp from "sharp";
import { isRaftUploadedHumanAvatarUrl } from "../../web/src/utils/humanAvatar";
import { migratePglite } from "../src/db/pgliteMigrations";
import { __setCdnStorageForTests, resetStorageForTests, type StorageBackend } from "../src/services/storageService";
import {
  candidateGroup, checkEndpoint, checkStorage, DEFAULT_DEPS, DEFAULT_OPTIONS, gravatarHash, gravatarUrl, parseArgs, rendersStoredAvatar, run,
  type Deps, type Options,
} from "./migrate-gravatar-avatars";

class MemoryStorage implements StorageBackend {
  readonly objects = new Map<string, Buffer>();
  async put(key: string, data: Buffer): Promise<void> {
    this.objects.set(key, Buffer.from(data));
  }
  async get(key: string): Promise<Readable> {
    const value = this.objects.get(key);
    if (!value) throw new Error("missing object");
    return Readable.from(value);
  }
  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

// The real schema (every migration), seeded with raw SQL.
const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const HEX32 = "0123456789abcdef0123456789abcdef";
const OTHER_HEX32 = "fedcba9876543210fedcba9876543210";

/** What Gravatar answers for the user's email. */
type Answer = { image: [number, number, number] } | 404 | 429 | 500 | "timeout" | "too_large";
type Seed = { avatarUrl: string | null; retired?: boolean; answer?: Answer };

// Ids in walk order. Comments: what the web shows today.
const USERS: Record<string, Seed> = {
  [id(1)]: { avatarUrl: null, answer: { image: [255, 0, 0] } }, // Gravatar
  [id(2)]: { avatarUrl: "", answer: 404 }, // User icon
  [id(3)]: { avatarUrl: "https://lh3.googleusercontent.com/a/abc=s96-c", answer: { image: [0, 255, 0] } }, // old link ignored: Gravatar
  [id(4)]: { avatarUrl: `/api/avatars/users/${HEX32}.webp` }, // stored
  [id(5)]: { avatarUrl: `https://cdn.example.test/avatars/users/${OTHER_HEX32}.webp` }, // stored, on the CDN
  [id(6)]: { avatarUrl: "/avatars/users/abc.webp" }, // the web takes any hex length as stored (the server's check would not)
  [id(7)]: { avatarUrl: `/api/avatars/users/${HEX32}.webp?v=2`, answer: 404 }, // relative with a query: the web falls to Gravatar
  [id(8)]: { avatarUrl: null, retired: true, answer: { image: [9, 9, 9] } }, // retired: never touched
  [id(9)]: { avatarUrl: "https://avatars.slack-edge.com/x.png", answer: 429 },
  [id(10)]: { avatarUrl: null, answer: 500 },
  [id(11)]: { avatarUrl: null, answer: "timeout" },
};
const email = (userId: string) => `User.${userId.slice(-4)}@Example.test `;
const byHash = new Map(Object.keys(USERS).map((userId) => [gravatarHash(email(userId)), userId]));

let template: File | Blob;
let storage: MemoryStorage;

beforeAll(async () => {
  const db = new PGlite();
  await migratePglite(db);
  template = await db.dumpDataDir("none");
  await db.close();
});

beforeEach(() => {
  vi.stubEnv("CDN_BASE_URL", "");
  vi.stubEnv("PUBLIC_CONTENT_BASE_URL", "");
  storage = new MemoryStorage();
  __setCdnStorageForTests(storage);
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetStorageForTests();
});

async function seeded(users: Record<string, Seed> = USERS): Promise<PGlite> {
  const db = new PGlite({ loadDataDir: template });
  for (const [userId, seed] of Object.entries(users)) {
    await db.query(
      `INSERT INTO users (id, email, name, password_hash, avatar_url, retired_at) VALUES ($1, $2, $3, 'x', $4, ${seed.retired ? "now()" : "NULL"})`,
      [userId, email(userId), `u${userId.slice(-4)}`, seed.avatarUrl],
    );
  }
  return db;
}

const png = (rgb: [number, number, number]) => sharp({ create: { width: 8, height: 8, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } } }).png().toBuffer();

/** Fake Gravatar from USERS' answers; records requested URLs. A fake clock that only sleeps move. */
function fakes(users: Record<string, Seed> = USERS, overrides: Partial<Deps> = {}) {
  const requests: string[] = [];
  const sleeps: number[] = [];
  let clock = 1_000_000;
  const deps: Deps = {
    ...DEFAULT_DEPS,
    async fetch(input, init) {
      requests.push(input);
      const hash = /\/avatar\/([0-9a-f]{64})\?/.exec(input)?.[1] ?? "";
      const answer = users[byHash.get(hash) ?? ""]?.answer ?? 404;
      if (answer === "timeout") {
        return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
      }
      if (answer === "too_large") return new Response("x", { status: 200, headers: { "content-length": String(6 * 1024 * 1024) } });
      if (typeof answer === "number") return new Response("", { status: answer, headers: answer === 429 ? { "retry-after": "7" } : {} });
      return new Response(new Uint8Array(await png(answer.image)), { status: 200, headers: { "content-type": "image/png" } });
    },
    async sleep(ms) {
      sleeps.push(ms);
      clock += ms;
    },
    now: () => clock,
    ...overrides,
  };
  return { deps, requests, sleeps };
}

const quiet = (overrides: Partial<Options> = {}, lines?: string[]): Options => ({
  ...DEFAULT_OPTIONS, batchSize: 3, timeoutMs: 50, log: (line) => lines?.push(line), ...overrides,
});
const userRows = async (db: PGlite) => (await db.query<{ id: string; avatar_url: string | null; updated_at: Date }>(
  `SELECT id, avatar_url, updated_at FROM users ORDER BY id`,
)).rows;
const avatarOf = async (db: PGlite, userId: string) => (await userRows(db)).find((row) => row.id === userId)!.avatar_url;

test("the candidate predicate is the web's: stored user avatars are kept, anything else falls to Gravatar", () => {
  const urls = [
    null, undefined, "", " ", `/api/avatars/users/${HEX32}.webp`, `/avatars/users/${HEX32}.webp`, "/avatars/users/abc.webp",
    `https://cdn.example.test/avatars/users/${HEX32}.webp`, `https://cdn.example.test/avatars/users/${HEX32}.webp?v=1`,
    `/api/avatars/users/${HEX32}.webp?v=2`, `/api/avatars/users/${HEX32}.png`, `/api/avatars/${id(1)}/${HEX32}.webp`,
    `//cdn.example.test/avatars/users/${HEX32}.webp`, "https://lh3.googleusercontent.com/a/abc=s96-c", "not a url",
    `/API/AVATARS/USERS/${HEX32.toUpperCase()}.WEBP`, `https://x.test/avatars/users/${HEX32}.webp/extra`,
  ];
  for (const url of urls) assert.equal(rendersStoredAvatar(url), isRaftUploadedHumanAvatarUrl(url), `same as the web for ${JSON.stringify(url)}`);
  assert.deepEqual([candidateGroup(null), candidateGroup(""), candidateGroup(" "), candidateGroup(`/avatars/users/${HEX32}.webp`)], ["empty", "empty", "oldLink", null]);
  assert.equal(gravatarHash(" A@B.test "), gravatarHash("a@b.test"));
  assert.equal(gravatarUrl("ab"), "https://www.gravatar.com/avatar/ab?d=404&s=256");
});

test("--no-fetch counts each group, never contacts Gravatar and writes nothing", async () => {
  const db = await seeded();
  const before = await userRows(db);
  const { deps, requests } = fakes();
  const lines: string[] = [];
  const result = await run(db, deps, quiet({ fetch: false }, lines));
  assert.equal(result.completed, true);
  assert.deepEqual(
    [result.counts.scanned, result.counts.retired, result.counts.stored, result.counts.candidatesEmpty, result.counts.candidatesOldLink],
    [11, 1, 3, 4, 3],
  );
  assert.deepEqual([result.counts.hitsEmpty + result.counts.hitsOldLink, result.counts.misses, result.counts.errors], [0, 0, 0]);
  assert.deepEqual([result.firstCandidateId, result.lastCandidateId], [id(1), id(11)]);
  assert.equal(requests.length, 0, "no Gravatar request");
  assert.deepEqual(await userRows(db), before);
  assert.equal(storage.objects.size, 0);
  assert.equal(lines.filter((line) => line.startsWith("[GRAVATAR_AVATARS_RECEIPT] run_id=- mode=dry-run-no-fetch ")).length, 4, "one receipt per slice");
});

test("a dry-run asks Gravatar for each candidate and counts hits, 404s and errors, writing nothing", async () => {
  const db = await seeded();
  const before = await userRows(db);
  const { deps, requests } = fakes();
  const result = await run(db, deps, quiet());
  assert.deepEqual(
    [result.counts.hitsEmpty, result.counts.hitsOldLink, result.counts.misses, result.counts.errors],
    [1, 1, 2, 3],
  );
  assert.deepEqual(result.errorsByReason, { rate_limited: 1, server_error: 1, timeout: 1 });
  assert.deepEqual(result.errorIds, [id(9), id(10), id(11)]);
  assert.equal(requests.length, 7, "candidates only (not stored, not retired)");
  assert.ok(requests.every((url) => /^https:\/\/www\.gravatar\.com\/avatar\/[0-9a-f]{64}\?d=404&s=256$/.test(url)));
  assert.deepEqual([result.counts.migratedEmpty, result.counts.migratedOldLink, result.counts.lostRace], [0, 0, 0]);
  assert.deepEqual(await userRows(db), before, "dry-run writes nothing");
  assert.equal(storage.objects.size, 0, "dry-run stores nothing");
});

test("--apply stores a 200 through the upload pipeline and updates; 404s and errors are left alone", async () => {
  const db = await seeded();
  const before = await userRows(db);
  const { deps, sleeps } = fakes();
  const lines: string[] = [];
  const result = await run(db, deps, quiet({ write: true, runId: "g1" }, lines));
  assert.deepEqual([result.counts.migratedEmpty, result.counts.migratedOldLink, result.counts.misses, result.counts.errors], [1, 1, 2, 3]);
  const after = await userRows(db);
  for (const row of after) {
    const old = before.find((b) => b.id === row.id)!;
    if (row.id === id(1) || row.id === id(3)) {
      assert.match(row.avatar_url ?? "", /^\/api\/avatars\/users\/[0-9a-f]{32}\.webp$/, `user ${row.id} now has a stored avatar`);
      assert.ok(rendersStoredAvatar(row.avatar_url), "the web shows it");
      const key = row.avatar_url!.replace(/^\/api\//, "");
      const meta = await sharp(storage.objects.get(key)!).metadata();
      assert.deepEqual([meta.format, meta.width, meta.height], ["webp", 256, 256], "resized and converted like an upload");
      assert.ok(row.updated_at > old.updated_at);
    } else {
      // 404 (no Gravatar: the User icon stays), errors (never taken for 404), stored, retired: untouched.
      assert.deepEqual(row, old, `user ${row.id} untouched`);
    }
  }
  assert.equal(storage.objects.size, 2);
  const migrated = lines.filter((line) => line.startsWith("[GRAVATAR_AVATARS_MIGRATED] run_id=g1 "));
  assert.ok(migrated.some((line) => line.includes(`user=${id(3)} group=oldLink old="https://lh3.googleusercontent.com/a/abc=s96-c" new=/api/avatars/users/`)), migrated.join("\n"));
  assert.ok(migrated.some((line) => line.includes(`user=${id(1)} group=empty old=null new=`)));
  assert.equal(lines.filter((line) => line.startsWith("[GRAVATAR_AVATARS_RECEIPT] run_id=g1 mode=apply ")).length, 4);
  // 5 rps pacing, and the 429's Retry-After (7 s) holds the next request back.
  assert.ok(sleeps.includes(200), `paced: ${sleeps.join(",")}`);
  assert.ok(sleeps.some((ms) => ms >= 7000), `backed off: ${sleeps.join(",")}`);

  // Re-run: the migrated users are no longer candidates; the rest are asked again.
  const again = await run(db, fakes().deps, quiet({ write: true, runId: "g2" }));
  assert.deepEqual([again.counts.candidatesEmpty, again.counts.candidatesOldLink, again.counts.migratedEmpty + again.counts.migratedOldLink], [3, 2, 0]);
  assert.deepEqual(await userRows(db), after);
});

test("a conditional UPDATE that loses to the person's own change keeps it and deletes the orphan", async () => {
  const users: Record<string, Seed> = {
    [id(1)]: { avatarUrl: null, answer: { image: [1, 2, 3] } },
    [id(2)]: { avatarUrl: "https://old.example.test/a.png", answer: { image: [4, 5, 6] } },
  };
  const db = await seeded(users);
  const theirs = `/api/avatars/users/${OTHER_HEX32}.webp`;
  const stored: string[] = [];
  const { deps } = fakes(users, {
    async store(existing, image) {
      const url = await DEFAULT_DEPS.store(existing, image);
      stored.push(url);
      // Between the read and the UPDATE: user 1 uploads their own avatar; user 2 uploads the very image we stored.
      const userId = stored.length === 1 ? id(1) : id(2);
      await db.query(`UPDATE users SET avatar_url = $1 WHERE id = $2`, [stored.length === 1 ? theirs : url, userId]);
      return url;
    },
  });
  const lines: string[] = [];
  const result = await run(db, deps, quiet({ write: true, runId: "g3" }, lines));
  assert.deepEqual([result.counts.lostRace, result.counts.orphansDeleted, result.counts.migratedEmpty + result.counts.migratedOldLink], [2, 1, 0]);
  assert.equal(await avatarOf(db, id(1)), theirs, "their change wins");
  assert.equal(storage.objects.has(stored[0]!.replace(/^\/api\//, "")), false, "our object deleted");
  assert.equal(await avatarOf(db, id(2)), stored[1], "their change wins");
  assert.equal(storage.objects.has(stored[1]!.replace(/^\/api\//, "")), true, "an object someone shows is kept");
  assert.ok(lines.some((line) => line.startsWith(`[GRAVATAR_AVATARS_LOST_RACE] run_id=g3 user=${id(1)} `) && line.endsWith("orphan_deleted=true")));
});

test("a stored URL the web would not show, or one off the CDN, is never written", async () => {
  const users: Record<string, Seed> = { [id(1)]: { avatarUrl: null, answer: { image: [7, 7, 7] } } };
  const db = await seeded(users);
  const result = await run(db, fakes(users).deps, quiet({ write: true, runId: "g4", expectedUrlPrefix: "https://cdn.example.test/avatars/users/" }));
  assert.deepEqual([result.errorsByReason, result.counts.migratedEmpty], [{ bad_url: 1 }, 0]);
  assert.equal(await avatarOf(db, id(1)), null);
  assert.equal(storage.objects.size, 0, "the unreferenced object is deleted");
});

test("an oversized image is an error; a run of errors stops where they began", async () => {
  const users: Record<string, Seed> = {
    [id(1)]: { avatarUrl: null, answer: 404 },
    [id(2)]: { avatarUrl: null, answer: "too_large" },
    [id(3)]: { avatarUrl: null, answer: 500 },
    [id(4)]: { avatarUrl: null, answer: 500 },
    [id(5)]: { avatarUrl: null, answer: { image: [1, 1, 1] } },
  };
  const db = await seeded(users);
  const lines: string[] = [];
  const result = await run(db, fakes(users).deps, quiet({ write: true, runId: "g5", maxConsecutiveErrors: 3 }, lines));
  assert.deepEqual([result.completed, result.stopReason, result.lastId, result.resumeAfter], [false, "consecutive_errors", id(4), id(1)]);
  assert.deepEqual(result.errorsByReason, { too_large: 1, server_error: 2 });
  assert.ok(lines.includes(`[GRAVATAR_AVATARS_RESUME] --start-after ${id(1)}`), lines.join("\n"));
  assert.equal(await avatarOf(db, id(5)), null, "not reached");
  const rest = await run(db, fakes(users).deps, quiet({ write: true, runId: "g5", startAfter: id(4) }));
  assert.deepEqual([rest.completed, rest.counts.scanned, rest.counts.migratedEmpty], [true, 1, 1]);
});

test("guards: arguments, endpoints and production storage", () => {
  const base = ["--environment", "production"];
  const dry = parseArgs(base);
  assert.deepEqual([dry.apply, dry.fetch, dry.rps, dry.batchSize], [false, true, 5, 500]);
  assert.equal(parseArgs([...base, "--no-fetch"]).fetch, false);
  const apply = parseArgs([...base, "--apply", "--approval-reference", "https://raft.example/m", "--run-id", "gm-1", "--rps", "2.5"]);
  assert.deepEqual([apply.apply, apply.rps], [true, 2.5]);
  assert.throws(() => parseArgs([]), /--environment/);
  assert.throws(() => parseArgs([...base, "--apply", "--run-id", "r"]), /--approval-reference/);
  assert.throws(() => parseArgs([...base, "--apply", "--approval-reference", "m"]), /--run-id/);
  assert.throws(() => parseArgs([...base, "--apply", "--approval-reference", "m", "--run-id", "r", "--no-fetch"]), /--no-fetch is only for a dry-run/);
  assert.throws(() => parseArgs([...base, "--run-id", "r"]), /only for --apply/);
  assert.throws(() => parseArgs([...base, "--rps", "0"]), /--rps/);
  assert.throws(() => parseArgs([...base, "--rps", "50"]), /--rps/);
  assert.throws(() => parseArgs([...base, "--start-after", "42"]), /--start-after/);
  assert.throws(() => parseArgs([...base, "--bogus"]), /Unknown argument/);

  assert.match(checkEndpoint("production", false, false) ?? "", /dry-run reads a replica/);
  assert.match(checkEndpoint("production", true, true) ?? "", /--apply writes to the primary/);
  assert.equal(checkEndpoint("production", false, true), null);
  assert.equal(checkEndpoint("production", true, false), null);
  assert.equal(checkEndpoint("staging", false, false), null);

  assert.deepEqual(checkStorage("production", false, {}), { refusal: null, expectedUrlPrefix: null });
  assert.match(checkStorage("production", true, {}).refusal ?? "", /CDN_BASE_URL, S3_CDN_BUCKET/);
  assert.match(checkStorage("production", true, { CDN_BASE_URL: "https://cdn.example.test" }).refusal ?? "", /S3_CDN_BUCKET/);
  assert.deepEqual(
    checkStorage("production", true, { CDN_BASE_URL: "https://cdn.example.test/", S3_CDN_BUCKET: "b", S3_ENDPOINT: "https://s3", S3_ACCESS_KEY_ID: "k", S3_SECRET_ACCESS_KEY: "s" }),
    { refusal: null, expectedUrlPrefix: "https://cdn.example.test/avatars/users/" },
  );
  assert.deepEqual(checkStorage("staging", true, {}), { refusal: null, expectedUrlPrefix: null });
});

test("a write run needs a run id and must fetch", async () => {
  const db = await seeded({});
  await assert.rejects(run(db, fakes({}).deps, quiet({ write: true })), /run id/);
  await assert.rejects(run(db, fakes({}).deps, quiet({ write: true, runId: "x", fetch: false })), /fetches/);
});
