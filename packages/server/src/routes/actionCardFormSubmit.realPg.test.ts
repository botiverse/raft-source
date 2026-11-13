// Real PostgreSQL teeth for form submission on action cards (form.v1, S2,
// spec §3.4; Tenny). PGlite serializes transactions on one connection, so
// actionCards.formSubmit.api.test.ts can only line requests up; here they run
// on separate connections and really wait on the card's lock:
// - a submitter that holds the card's lock (paused inside execute's
//   transaction) makes a second one wait for it, and the second then meets
//   the executed card: 409 ALREADY_EXECUTED, and the handler ran once;
// - three people submitting at once: exactly one executes, two get 409;
// - one person sending the same values twice at once: both 200 (the retry is
//   idempotent), one execution; with other values: 200 and 409;
// - a form whose handler delivers it to another service (feedback:submit to
//   Hands, F1) holds no lock while that service answers: the card's channel
//   still takes messages;
// - a question card's answer, withdraw, expiry, a conversion's freeze and the
//   agent's hourly budget (section below).
//
// Default-skipped. Run it with a server you can create tables in:
//   ACTION_CARD_FORM_REAL_PG_URL=postgresql://postgres@127.0.0.1:5432/postgres \
//     pnpm --filter @botiverse/raft-server test:action-card-form-real-pg
// CI: `probe-concurrency-real-pg`.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { and, count, eq, sql } from "drizzle-orm";
import pg from "pg";
import { afterEach } from "vitest";
import {
  FEEDBACK_SUBMIT_FORM_ID,
  QUESTION_CARD_ERROR_CODES,
  type ActionCardMetadata,
  type QuestionAskAction,
} from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { actionCards, channelConversionJobs, messages } from "../db/schema";
import { freezeActionCardsForConversion, setBetweenActionCardFreezeReadAndWriteForTest } from "../services/actionCardConversionService";
import { setActionCardFormHandlerForTest } from "../services/actionCardForms";
import {
  ActionCardError,
  expireQuestionCard,
  prepareActionCard,
  QUESTION_CARD_PER_HOUR,
  setBeforeActionCardAttemptAuditForTest,
  setBeforeActionCardExecutionLockForTest,
  withdrawQuestionCard,
} from "../services/actionCardsService";
import { lockChannelConversionResourceInTransaction } from "../services/channelConversionFenceService";
import * as channelService from "../services/channelService";
import * as messageService from "../services/messageService";
import { createApiTest } from "../test/integration/apiTest";
import { openTestApp } from "../test/integration/app";
import { migrateRealPgTestDatabase } from "../test/integration/realPgMigrate";
import {
  barrier, cardRow, channelCreateFormHandler, channelsNamed, goodValues, post, prepareCreate, seed, submit, type Fixture,
} from "../test/actionCardFormFixture";
import { HANDS_TICKET_REPLY, filedTickets, withHands, withHandsFeedbackConfigured } from "../test/handsFeedbackStub";

const test = createApiTest();

const REAL_PG_URL = process.env.ACTION_CARD_FORM_REAL_PG_URL;
const REAL_PG_REQUIRED = process.env.ACTION_CARD_FORM_REAL_PG_REQUIRED === "1";
const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));
const REAL_PG_TEST = { skip: !(REAL_PG_URL || REAL_PG_REQUIRED), timeout: 120_000 };

afterEach(() => {
  setActionCardFormHandlerForTest("channel:create", null);
  setBeforeActionCardExecutionLockForTest(null);
  setBeforeActionCardAttemptAuditForTest(null);
});

type TestApp = Awaited<ReturnType<typeof openTestApp>>;

async function withRealPgApp(run: (app: TestApp, f: Fixture) => Promise<void>) {
  assert.ok(REAL_PG_URL, "ACTION_CARD_FORM_REAL_PG_URL is required");
  const migrator = new pg.Pool({ connectionString: REAL_PG_URL, max: 2 });
  try {
    await migrateRealPgTestDatabase(migrator, MIGRATIONS_FOLDER);
  } finally {
    await migrator.end();
  }
  const app = await openTestApp(REAL_PG_URL, 0, { skipAuthRateLimit: true });
  try {
    const f = await seed(app);
    await channelService.addHuman(f.channel.id, f.bob.id);
    await run(app, f);
  } finally {
    await app.close();
  }
}

/** Polls until `count` backends of this database wait on a heavyweight lock. */
async function waitForLockWaiters(count: number) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const { rows } = await getDb().execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'`);
    if (Number(rows[0]!.n) >= count) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${count} lock waiter(s)`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function gate() {
  let release!: () => void;
  const opened = new Promise<void>((resolve) => { release = resolve; });
  return { opened, release };
}

test("real PG: a second submitter waits on the card's lock, then gets 409 ALREADY_EXECUTED; the handler runs once", REAL_PG_TEST, async () => {
  await withRealPgApp(async (app, f) => {
    const calls = channelCreateFormHandler();
    const card = await prepareCreate(f);
    const inside = gate();
    const hold = gate();
    let entered = 0;
    // The first request to pass the card's locks pauses before its attempt
    // audit, still holding them.
    setBeforeActionCardAttemptAuditForTest(async () => {
      entered += 1;
      if (entered === 1) { inside.release(); await hold.opened; }
    });
    const first = submit(app.baseUrl, f, "alice", card.messageId, goodValues(f));
    await inside.opened;
    const second = submit(app.baseUrl, f, "owner", card.messageId, goodValues(f));
    await waitForLockWaiters(1);
    hold.release();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.status, 200, a.text);
    assert.equal(b.status, 409, b.text);
    assert.equal(b.body.errorCode, "ALREADY_EXECUTED");
    assert.equal(b.body.metadata.executedByUserId, f.alice.id);
    assert.equal(entered, 1, "the second never reached the attempt: it met the executed card");
    assert.deepEqual(calls, { validate: 1, execute: 1 });
    assert.equal((await channelsNamed(f.server.id, "launch-room")).length, 1);
    assert.equal((await cardRow(card.messageId)).executedByUserId, f.alice.id);
  });
});

test("real PG: three people submit at once: exactly one executes, two get 409", REAL_PG_TEST, async () => {
  await withRealPgApp(async (app, f) => {
    const calls = channelCreateFormHandler();
    const card = await prepareCreate(f);
    setBeforeActionCardExecutionLockForTest(barrier(3));
    const results = await Promise.all((["alice", "owner", "bob"] as const).map((who) => submit(app.baseUrl, f, who, card.messageId, goodValues(f))));
    setBeforeActionCardExecutionLockForTest(null);
    assert.deepEqual(results.map((res) => res.status).sort(), [200, 409, 409], results.map((res) => res.text).join("\n"));
    for (const res of results.filter((each) => each.status === 409)) assert.equal(res.body.errorCode, "ALREADY_EXECUTED");
    const winner = results.find((res) => res.status === 200)!.body.metadata.executedByUserId as string;
    assert.equal((await cardRow(card.messageId)).executedByUserId, winner);
    assert.deepEqual(calls, { validate: 1, execute: 1 });
    assert.equal((await channelsNamed(f.server.id, "launch-room")).length, 1);
  });
});

test("real PG: one person sending the same values twice at once gets 200 twice; other values get 409", REAL_PG_TEST, async () => {
  await withRealPgApp(async (app, f) => {
    const calls = channelCreateFormHandler();
    const same = await prepareCreate(f, { name: "same-room" });
    const values = { ...goodValues(f), name: "same-room" };
    setBeforeActionCardExecutionLockForTest(barrier(2));
    const twice = await Promise.all([submit(app.baseUrl, f, "alice", same.messageId, values), submit(app.baseUrl, f, "alice", same.messageId, values)]);
    setBeforeActionCardExecutionLockForTest(null);
    assert.deepEqual(twice.map((res) => res.status), [200, 200], twice.map((res) => res.text).join("\n"));
    assert.deepEqual(twice[0]!.body, twice[1]!.body);
    assert.equal((await channelsNamed(f.server.id, "same-room")).length, 1);

    const other = await prepareCreate(f, { name: "other-room" });
    setBeforeActionCardExecutionLockForTest(barrier(2));
    const differing = await Promise.all([
      submit(app.baseUrl, f, "alice", other.messageId, { ...goodValues(f), name: "other-room" }),
      submit(app.baseUrl, f, "alice", other.messageId, { ...goodValues(f), name: "other-room", note: "other" }),
    ]);
    setBeforeActionCardExecutionLockForTest(null);
    assert.deepEqual(differing.map((res) => res.status).sort(), [200, 409], differing.map((res) => res.text).join("\n"));
    assert.deepEqual(calls, { validate: 2, execute: 2 }, "one execution per card");
  });
});

test("real PG: a feedback form holds no lock while Hands answers: the card's channel still takes messages", REAL_PG_TEST, async () => {
  await withRealPgApp(async (app, f) => {
    const card = await withHandsFeedbackConfigured(() => prepareActionCard({
      serverId: f.server.id,
      requesterAgentId: f.agent.id,
      targetChannelId: f.channel.id,
      action: { type: "feedback:submit", feedbackType: "idea", message: "Agent draft." },
    }));
    const atHands = gate();
    const answer = gate();
    await withHands(async (requests) => {
      const pending = post(app.baseUrl, f, "alice", `${card.messageId}/execute`, {
        expectedState: "prepared", expectedConfirmationVersion: 1, form: { id: FEEDBACK_SUBMIT_FORM_ID, values: { type: "idea", message: "Sent as edited." } },
      });
      await atHands.opened;
      // A message's insert takes a key-share lock on its channel's row, which
      // execute's transaction holds for update (assertActionCardWritableByUser).
      const meanwhile = await Promise.race([
        messageService.createMessage(f.channel.id, "user", f.owner.id, "said while Hands was answering"),
        new Promise<"blocked">((resolve) => { setTimeout(() => resolve("blocked"), 5_000); }),
      ]);
      answer.release();
      assert.notEqual(meanwhile, "blocked", "a message in the card's channel waited for Hands");
      const res = await pending;
      assert.equal(res.status, 200, res.text);
      assert.equal(filedTickets(requests).length, 1);
    }, async () => {
      atHands.release();
      await answer.opened;
      return HANDS_TICKET_REPLY;
    });
    assert.equal((await cardRow(card.messageId)).state, "executed");
  });
});

// ---------------------------------------------------------------------------
// Question cards (question:ask; question-card spec §4.4, Tenny and AppFather on
// #12862). PGlite runs one connection, so actionCards.questionAsk.api.test.ts
// passes with these locks taken out; here each writer has its own connection:
// - answer and withdraw take the card's source lock
//   (lockActionCardSourceInTransaction): whichever holds it, the other waits
//   on it and then learns it lost (ALREADY_ANSWERED / QUESTION_WITHDRAWN), and
//   the card's row and its message say the same; raced at once, exactly one
//   wins;
// - a conversion's freeze reads the cards and then writes them under the
//   conversion's exclusive lock: a withdraw or an expiry arriving between that
//   read and that write waits for it (the card stays frozen, in its row and in
//   its message alike); one that came first makes the freeze pass the ended
//   card over;
// - the hourly cap counts across conversations under the agent's own budget
//   lock: two prepares of one agent in two conversations at 29 cannot both
//   pass.
// Every wait here is proven to be on the intended holder (pg_blocking_pids),
// never a count of waiters.

const LOCK_WAIT_POLLS = 200;

afterEach(() => {
  setBetweenActionCardFreezeReadAndWriteForTest(null);
});

async function withQuestionCardApp(run: (app: TestApp, f: Fixture, observer: pg.Pool) => Promise<void>) {
  assert.ok(REAL_PG_URL, "ACTION_CARD_FORM_REAL_PG_URL is required");
  const observer = new pg.Pool({ connectionString: REAL_PG_URL, max: 2 });
  try {
    await migrateRealPgTestDatabase(observer, MIGRATIONS_FOLDER);
    const app = await openTestApp(REAL_PG_URL, 0, { skipAuthRateLimit: true });
    try {
      await run(app, await seed(app), observer);
    } finally {
      await app.close();
    }
  } finally {
    await observer.end();
  }
}

/** A value one side learns and the other awaits (a backend pid). */
function later<T>() {
  let resolve!: (value: T) => void;
  const value = new Promise<T>((done) => { resolve = done; });
  return { value, resolve };
}

/** The backend pid of the transaction this runs in (a hook inside a writer's transaction, or an outer one). */
async function ambientPid(): Promise<number> {
  const result = await getDb().execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
  return Number(result.rows[0]!.pid);
}

/** The sessions blocked by exactly this backend, once there is one (never any session's wait). */
async function waitForBlockedBy(observer: pg.Pool, blockerPid: number): Promise<number[]> {
  for (let poll = 0; poll < LOCK_WAIT_POLLS; poll += 1) {
    const { rows } = await observer.query<{ pid: number }>(
      "SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))", [blockerPid]);
    if (rows.length > 0) return rows.map((row) => row.pid);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return [];
}

/** Settles a promise into its value or its error, so a test can hold both sides before asserting. */
const settle = <T>(promise: Promise<T>) => promise.then(
  (value) => ({ ok: true as const, value }),
  (error: unknown) => ({ ok: false as const, error }),
);

const QUESTION = {
  type: "question:ask",
  ref: "lock-1",
  questions: [{ id: "window", kind: "single", text: "Which window?", options: [{ value: "tue", label: "Tue 10:00" }, { value: "wed", label: "Wed 15:00" }] }],
};

async function prepareQuestion(f: Fixture, channelId = f.channel.id, beforeCommit?: Parameters<typeof prepareActionCard>[0]["beforeCommit"]) {
  return prepareActionCard({
    serverId: f.server.id,
    requesterAgentId: f.agent.id,
    targetChannelId: channelId,
    action: { ...QUESTION, to: `@${f.alice.name}` },
    agentAuthored: true,
    ...(beforeCommit ? { beforeCommit } : {}),
  });
}

const answer = (app: TestApp, f: Fixture, messageId: string) =>
  post(app.baseUrl, f, "alice", `${messageId}/execute`, { expectedState: "prepared", form: { id: "answers", values: { window: { selected: ["tue"] } } } });

const withdraw = (f: Fixture, messageId: string) =>
  withdrawQuestionCard({ serverId: f.server.id, requesterAgentId: f.agent.id, messageRef: messageId });

/** The card's state as its row and as its message have it: [row state, row freezeState, message state]. */
async function cardStates(messageId: string): Promise<[string, string, string]> {
  const row = await cardRow(messageId);
  const [message] = await getDb().select({ actionMetadata: messages.actionMetadata }).from(messages).where(eq(messages.id, messageId));
  return [row.state, row.freezeState, (message!.actionMetadata as ActionCardMetadata).state];
}

function assertRefused(outcome: { ok: true } | { ok: false; error: unknown }, code: string) {
  assert.equal(outcome.ok, false, `expected ${code}`);
  const { error } = outcome as { error: unknown };
  assert.ok(error instanceof ActionCardError, String(error));
  assert.equal(error.code, code);
}

/** A conversion's start, as channelConversionService does it: the exclusive conversion lock, its job, the freeze. */
function startConversion(f: Fixture) {
  return getDb().transaction(async (tx) => {
    await lockChannelConversionResourceInTransaction(tx, f.server.id, f.channel.id);
    const [job] = await tx.insert(channelConversionJobs)
      .values({ serverId: f.server.id, sourceChannelId: f.channel.id, sourceChannelType: "channel" }).returning();
    return freezeActionCardsForConversion(tx, { id: job!.id, serverId: f.server.id, sourceChannelId: f.channel.id, conversionEpoch: job!.conversionEpoch });
  });
}

/** Moves a card's expiresAt into the past, on its row and its message alike. */
async function backdate(messageId: string) {
  const action = { ...((await cardRow(messageId)).payload as QuestionAskAction), expiresAt: "2001-01-01T00:00:00.000Z" };
  await getDb().update(actionCards).set({ payload: action }).where(eq(actionCards.messageId, messageId));
  const [message] = await getDb().select({ actionMetadata: messages.actionMetadata }).from(messages).where(eq(messages.id, messageId));
  await getDb().update(messages).set({ actionMetadata: { ...(message!.actionMetadata as ActionCardMetadata), action } }).where(eq(messages.id, messageId));
}

test("real PG: an answer holding the card's lock makes a withdraw wait, which then gets ALREADY_ANSWERED; row and message say executed", REAL_PG_TEST, async () => {
  await withQuestionCardApp(async (app, f, observer) => {
    const card = await prepareQuestion(f);
    const answerPid = later<number>();
    const hold = gate();
    let entered = 0;
    // The answer pauses past the card's locks, before its attempt audit, still holding them.
    setBeforeActionCardAttemptAuditForTest(async () => {
      entered += 1;
      if (entered !== 1) return;
      answerPid.resolve(await ambientPid());
      await hold.opened;
    });
    const answered = answer(app, f, card.messageId);
    const holder = await answerPid.value;
    const withdrawn = settle(withdraw(f, card.messageId));
    assert.ok((await waitForBlockedBy(observer, holder)).length > 0, "the withdraw waited on the answer's lock");
    hold.release();
    const [a, w] = await Promise.all([answered, withdrawn]);
    assert.equal(a.status, 200, a.text);
    assertRefused(w, QUESTION_CARD_ERROR_CODES.alreadyAnswered);
    assert.deepEqual(await cardStates(card.messageId), ["executed", "ready", "executed"]);
  });
});

test("real PG: a withdraw holding the card's lock makes an answer wait, which then gets QUESTION_WITHDRAWN; row and message say withdrawn", REAL_PG_TEST, async () => {
  await withQuestionCardApp(async (app, f, observer) => {
    const card = await prepareQuestion(f);
    const withdrawPid = later<number>();
    const withdrawDone = gate();
    const hold = gate();
    // The withdraw's own transaction joins this one, so its locks are held until this commits.
    const withdrawn = getDb().transaction(async () => {
      withdrawPid.resolve(await ambientPid());
      const out = await withdraw(f, card.messageId);
      withdrawDone.release();
      await hold.opened;
      return out;
    });
    const holder = await withdrawPid.value;
    // Only once the withdraw holds the lock does the answer start.
    await withdrawDone.opened;
    const answered = answer(app, f, card.messageId);
    assert.ok((await waitForBlockedBy(observer, holder)).length > 0, "the answer waited on the withdraw's lock");
    hold.release();
    const [w, a] = await Promise.all([withdrawn, answered]);
    assert.equal(w.alreadyWithdrawn, false);
    assert.equal(a.status, 409, a.text);
    assert.equal(a.body.errorCode, QUESTION_CARD_ERROR_CODES.withdrawn);
    assert.deepEqual(await cardStates(card.messageId), ["withdrawn", "ready", "withdrawn"]);
  });
});

test("real PG: an answer and a withdraw at once, five rounds: exactly one wins, and the row and the message agree", REAL_PG_TEST, async () => {
  await withQuestionCardApp(async (app, f) => {
    for (let round = 0; round < 5; round += 1) {
      const card = await prepareQuestion(f);
      const [a, w] = await Promise.all([answer(app, f, card.messageId), settle(withdraw(f, card.messageId))]);
      const states = await cardStates(card.messageId);
      if (w.ok) {
        assert.equal(a.status, 409, a.text);
        assert.equal(a.body.errorCode, QUESTION_CARD_ERROR_CODES.withdrawn);
        assert.deepEqual(states, ["withdrawn", "ready", "withdrawn"]);
      } else {
        assert.equal(a.status, 200, a.text);
        assertRefused(w, QUESTION_CARD_ERROR_CODES.alreadyAnswered);
        assert.deepEqual(states, ["executed", "ready", "executed"]);
      }
    }
  });
});

for (const end of ["withdraw", "expiry"] as const) {
  test(`real PG: a ${end} arriving between a conversion's freeze read and its write waits for the freeze; the card stays frozen in its row and its message`, REAL_PG_TEST, async () => {
    await withQuestionCardApp(async (_app, f, observer) => {
      const card = await prepareQuestion(f);
      if (end === "expiry") await backdate(card.messageId);
      const freezePid = later<number>();
      const hold = gate();
      setBetweenActionCardFreezeReadAndWriteForTest(async () => {
        freezePid.resolve(await ambientPid());
        await hold.opened;
      });
      const frozen = startConversion(f);
      const holder = await freezePid.value;
      // One result type for both ends: a withdraw's card, or whether the expiry ended it.
      const ending: Promise<unknown> = end === "withdraw"
        ? withdraw(f, card.messageId)
        : expireQuestionCard({ messageId: card.messageId, io: null, orchestrator: null });
      const ended = settle(ending);
      assert.ok((await waitForBlockedBy(observer, holder)).length > 0, `the ${end} waited on the freeze`);
      hold.release();
      assert.equal(await frozen, 1);
      const outcome = await ended;
      if (end === "withdraw") assertRefused(outcome, "BAD_STATE");
      else assert.deepEqual(outcome, { ok: true, value: false }, "nothing expired: the card is frozen");
      assert.deepEqual(await cardStates(card.messageId), ["prepared", "frozen", "frozen"]);
    });
  });
}

test("real PG: a withdraw that holds the lock first makes the freeze wait, which then passes the withdrawn card over", REAL_PG_TEST, async () => {
  await withQuestionCardApp(async (_app, f, observer) => {
    const card = await prepareQuestion(f);
    const withdrawPid = later<number>();
    const withdrawDone = gate();
    const hold = gate();
    const withdrawn = getDb().transaction(async () => {
      withdrawPid.resolve(await ambientPid());
      const out = await withdraw(f, card.messageId);
      withdrawDone.release();
      await hold.opened;
      return out;
    });
    const holder = await withdrawPid.value;
    await withdrawDone.opened;
    const frozen = startConversion(f);
    assert.ok((await waitForBlockedBy(observer, holder)).length > 0, "the freeze waited on the withdraw");
    hold.release();
    assert.equal((await withdrawn).alreadyWithdrawn, false);
    assert.equal(await frozen, 0, "nothing open to freeze");
    assert.deepEqual(await cardStates(card.messageId), ["withdrawn", "ready", "withdrawn"]);
  });
});

test("real PG: two prepares of one agent in two conversations at 29 in the hour: the second waits on the agent's budget lock, and only one is posted", REAL_PG_TEST, async () => {
  await withQuestionCardApp(async (_app, f, observer) => {
    const other = await channelService.createChannel(f.server.id, `question-other-${f.channel.name.slice(-6)}`);
    await channelService.addHuman(other.id, f.alice.id);
    await channelService.addAgent(other.id, f.agent.id);
    // 29 earlier cards of this agent's in the hour (withdrawn: none open anywhere).
    const seedCard = await prepareQuestion(f);
    const payload = (await cardRow(seedCard.messageId)).payload as object;
    for (let i = 0; i < QUESTION_CARD_PER_HOUR - 2; i += 1) {
      const [message] = await getDb().insert(messages)
        .values({ channelId: f.channel.id, senderType: "agent", senderId: f.agent.id, content: "earlier", messageType: "chat" }).returning();
      await getDb().insert(actionCards).values({
        serverId: f.server.id, messageId: message!.id, requesterAgentId: f.agent.id, actionType: "question:ask", payload, state: "withdrawn",
      });
    }
    await getDb().update(actionCards).set({ state: "withdrawn" }).where(eq(actionCards.messageId, seedCard.messageId));
    const inHour = async () => Number((await getDb().select({ n: count() }).from(actionCards)
      .where(and(eq(actionCards.requesterAgentId, f.agent.id), eq(actionCards.actionType, "question:ask"))))[0]!.n);
    assert.equal(await inHour(), QUESTION_CARD_PER_HOUR - 1);

    const firstPid = later<number>();
    const hold = gate();
    // The first holds its transaction open after posting, with the budget lock.
    const first = settle(prepareQuestion(f, f.channel.id, async (executor) => {
      const result = await executor.execute(sql`SELECT pg_backend_pid() AS pid`);
      firstPid.resolve(Number((result.rows[0] as { pid: number }).pid));
      await hold.opened;
    }));
    const holder = await firstPid.value;
    const second = settle(prepareQuestion(f, other.id));
    const waiting = await waitForBlockedBy(observer, holder);
    assert.ok(waiting.length > 0, "the second prepare waited on the first");
    // On an advisory lock: its own conversation's source lock is free, so this is the agent's budget lock.
    const { rows: waits } = await observer.query<{ locktype: string }>("SELECT locktype FROM pg_locks WHERE pid = ANY($1::int[]) AND NOT granted", [waiting]);
    assert.deepEqual(waits.map((row) => row.locktype), ["advisory"]);
    hold.release();
    const [a, b] = await Promise.all([first, second]);
    assert.ok(a.ok, String(a.ok ? "" : a.error));
    assertRefused(b, QUESTION_CARD_ERROR_CODES.rateLimited);
    assert.equal((b as { error: ActionCardError }).error.status, 429);
    assert.equal(await inHour(), QUESTION_CARD_PER_HOUR);
  });
});
