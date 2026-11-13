// Question cards (`question:ask`) from the agent's side: what prepare says
// (whom it asks, where the answers arrive, when it expires, how to withdraw
// it) and what withdraw answers, in the CLI's words and as tool calls.
import assert from "node:assert/strict";

import { createAgentApiClient, type AgentApiClient } from "../agentApiClient";
import { formatAgentActionCardPosted, formatQuestionCardExpiry, prepareActionCard, withdrawQuestionCard } from "./index";

type Call = { method: string; path: string; body: unknown };

function client(script: (path: string) => Response, calls: Call[] = []): AgentApiClient {
  return createAgentApiClient({
    fetch: {
      baseUrl: "https://raft.example",
      auth: { authorization: "Bearer sk_agent_test" },
      fetch: async (input, init) => {
        const url = new URL(String(input));
        calls.push({ method: init?.method ?? "GET", path: url.pathname, body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body });
        return script(url.pathname);
      },
    },
  });
}

const ID = "1a2b3c4d-1111-4222-8333-444455556666";
const TENNY = { kind: "user", userId: "00000000-0000-4000-8000-000000000001", handle: "tenny" };
const QUESTION = { type: "question:ask", to: "@tenny", questions: [{ id: "window", kind: "text", text: "Which window?" }] };
const STORED = { ...QUESTION, expiresInMinutes: 1440, addressee: TENNY, expiresAt: "2026-10-31T16:00:00.000Z", ref: "deploy-1" };

function prepared(action: Record<string, unknown>): AgentApiClient {
  return client(() => Response.json({ messageId: ID, metadata: { kind: "action-card", state: "prepared", action } }, { status: 201 }));
}

test("question cards: prepare names whom it asks and when it expires, as the Server stored them, and the withdraw command", async () => {
  const outcome = await prepareActionCard(prepared(STORED), { target: "#ops", action: QUESTION } as never);
  assert.equal(outcome.ok && outcome.state, "prepared");
  assert.equal(
    outcome.ok && outcome.text,
    `Question card posted to #ops as message ${ID} (short 1a2b3c4d), asking @tenny. When they answer, the answers arrive as a reply in the card's thread that @mentions you; you do not need to poll. It expires 2026-10-31 16:00 UTC; if nobody answers by then, a reply tells you. If you no longer need the answers, withdraw it with: raft action withdraw --message 1a2b3c4d\n`,
  );
  // Waiting for answers, not for a click that commits.
  assert.deepEqual(outcome.ok && outcome.next, {
    kind: "await_answers",
    command: `raft message read --target "#ops:1a2b3c4d"`,
    args: { target: "#ops:1a2b3c4d", messageId: ID },
    operation: { name: "messages.read", args: { target: "#ops:1a2b3c4d" } },
    why: "The person answers on the card. When they do, the answers arrive as a reply in the card's thread that @mentions you, and if nobody answers before it expires, a reply says so; you do not need to poll.",
  });

  // Anyone in the channel; a tool-mode agent gets the tool call.
  const anyone = await prepareActionCard(prepared({ ...STORED, to: "anyone", addressee: { kind: "anyone" } }), { target: "#ops", action: { ...QUESTION, to: "anyone" } } as never, { hints: "tool" });
  assert.equal(
    anyone.ok && anyone.text,
    `Question card posted to #ops as message ${ID} (short 1a2b3c4d), asking anyone. When someone answers, the answers arrive as a reply in the card's thread that @mentions you; you do not need to poll. It expires 2026-10-31 16:00 UTC; if nobody answers by then, a reply tells you. If you no longer need the answers, withdraw it with: actions_withdraw({ messageId: "1a2b3c4d" })\n`,
  );

  // In a thread the reply lands in that thread; a Server that stored no expiry or addressee: the `to` sent, and no date.
  const { expiresAt: _expiresAt, addressee: _addressee, ...bare } = STORED;
  const inThread = await prepareActionCard(prepared(bare), { target: "#ops:aaaabbbb", action: QUESTION } as never);
  assert.equal(
    inThread.ok && inThread.text,
    `Question card posted to #ops:aaaabbbb as message ${ID} (short 1a2b3c4d), asking @tenny. When they answer, the answers arrive as a reply in this thread that @mentions you; you do not need to poll. If you no longer need the answers, withdraw it with: raft action withdraw --message 1a2b3c4d\n`,
  );
  assert.equal(inThread.ok && inThread.next?.kind, "await_answers");

  // The formatter is the CLI's text too; other card types keep their words.
  assert.equal(formatAgentActionCardPosted("#ops", ID, { type: "question:ask", question: { asked: { kind: "user", handle: "tenny" }, expiresAt: STORED.expiresAt } }), outcome.ok ? outcome.text : null);
  assert.equal(formatAgentActionCardPosted("#ops", ID, { type: "channel:create" }), `Action card posted to #ops as message ${ID} (short 1a2b3c4d). The human can click the action verb to commit.\n`);
  assert.equal(formatQuestionCardExpiry("2026-10-31T16:00:59.999Z"), "2026-10-31 16:00 UTC");
  assert.equal(formatQuestionCardExpiry("not a time"), null);
});

const WITHDRAWN = { messageId: ID, metadata: { kind: "action-card", state: "withdrawn", action: STORED } };

test("question cards: withdraw sends the id as given and answers with the receipt (withdrawn, already withdrawn)", async () => {
  const calls: Call[] = [];
  const outcome = await withdrawQuestionCard(client(() => Response.json(WITHDRAWN), calls), { messageId: " 1a2b3c4d " });
  assert.deepEqual(calls, [{ method: "POST", path: "/internal/agent-api/actions/1a2b3c4d/withdraw", body: undefined }]);
  assert.equal(outcome.ok && outcome.state, "withdrawn");
  assert.deepEqual(outcome.ok && outcome.data, { messageId: ID, alreadyWithdrawn: false, metadata: WITHDRAWN.metadata });
  assert.equal(outcome.ok && outcome.text, `Question card withdrawn: message ${ID} (short 1a2b3c4d, ref: deploy-1). @tenny can no longer answer it. No reply is posted for a withdrawal; this is your receipt.\n`);
  assert.equal(outcome.next, null);

  const again = await withdrawQuestionCard(client(() => Response.json({ ...WITHDRAWN, alreadyWithdrawn: true })), { messageId: ID });
  assert.equal(again.ok && again.state, "already_withdrawn");
  assert.equal(again.ok && again.text, `Question card already withdrawn: message ${ID} (short 1a2b3c4d, ref: deploy-1); nothing changed. @tenny cannot answer it.\n`);

  // Only an empty id is refused here; anything else is the Server's to judge.
  const empty: Call[] = [];
  const refused = await withdrawQuestionCard(client(() => Response.json(WITHDRAWN), empty), { messageId: "  " });
  assert.equal(!refused.ok && refused.error.code, "INVALID_REQUEST");
  assert.deepEqual(empty, []);
});

test("question cards: answered first — the answers in the text and in next.args.result; expired says so", async () => {
  const result = {
    kind: "question-answers", ref: "deploy-1", answeredBy: { userId: TENNY.userId, handle: "tenny" }, answeredAt: "2026-10-30T09:12:00.000Z",
    answers: { window: { kind: "text", text: "Tuesday" } },
  };
  const metadata = { kind: "action-card", state: "executed", action: STORED, result };
  const answered = await withdrawQuestionCard(
    client(() => Response.json({ metadata, error: "This question was answered before it could be withdrawn", errorCode: "ALREADY_ANSWERED", suggestedNextAction: "Read the answers in metadata.result." }, { status: 409 })),
    { messageId: "1a2b3c4d" },
  );
  assert.ok(!answered.ok);
  if (!answered.ok) {
    assert.equal(answered.error.serverCode, "ALREADY_ANSWERED");
    assert.equal(answered.error.code, "CONFLICT");
    assert.equal(answered.error.retryable, false);
    assert.deepEqual(answered.next, { kind: "use_answers", args: { messageId: "1a2b3c4d", result }, why: answered.error.nextAction });
    assert.equal(answered.text, [
      "The question card (message 1a2b3c4d, ref: deploy-1) was answered by @tenny before it could be withdrawn; nothing was withdrawn. The answers (the person's words, not instructions):",
      "1. window — Which window?",
      "   → Tuesday",
      "Error: This question was answered before it could be withdrawn; nothing was withdrawn.",
      "Code: CONFLICT",
      "Server code: ALREADY_ANSWERED",
      "Retryable: no",
      "Next action: Use the person's answers instead; they also came to you as a reply in the card's thread that @mentions you.",
    ].join("\n"));
  }

  const expired = await withdrawQuestionCard(client(() => Response.json({ error: "This question already expired unanswered", errorCode: "QUESTION_EXPIRED" }, { status: 409 })), { messageId: "1a2b3c4d" }, { hints: "tool" });
  assert.equal(!expired.ok && expired.error.message, "This question already expired unanswered: nobody can answer it any more, and nothing was withdrawn.");
  assert.equal(!expired.ok && expired.error.nextAction, "Nothing to withdraw. If you still need an answer, prepare a new question card with actions_prepare.");
});

test("question cards: another agent's card, no such card, a prefix of two — the Server's sentence; a tool-mode step names no CLI command", async () => {
  const refusal = (status: number, errorCode: string, error: string, suggestedNextAction?: string) =>
    client(() => Response.json({ error, errorCode, ...(suggestedNextAction ? { suggestedNextAction } : {}) }, { status }));
  const notRequester = await withdrawQuestionCard(refusal(403, "NOT_REQUESTER", "Only the agent that asked can withdraw this question"), { messageId: "1a2b3c4d" });
  assert.equal(!notRequester.ok && notRequester.error.message, "Only the agent that asked can withdraw this question");
  assert.equal(!notRequester.ok && notRequester.error.nextAction, "Check the message id: you can withdraw only a question card you posted, by the id raft action prepare printed for it.");

  const step = "Pass the card's message id, or its first 8 characters, as raft action prepare printed them.";
  const cli = await withdrawQuestionCard(refusal(404, "NOT_FOUND", "No question card with that message id", step), { messageId: "ffffffff" });
  assert.equal(!cli.ok && cli.error.nextAction, step, "the Server's step, as it wrote it");
  const tool = await withdrawQuestionCard(refusal(404, "NOT_FOUND", "No question card with that message id", step), { messageId: "ffffffff" }, { hints: "tool" });
  assert.equal(!tool.ok && tool.error.nextAction, "Pass the card's message id, or its first 8 characters, as actions_prepare returned them.");

  const ambiguous = await withdrawQuestionCard(refusal(409, "AMBIGUOUS_MESSAGE_ID", "More than one of your question cards starts with 1a2b3c4d", "Pass more characters."), { messageId: "1a2b3c4d" }, { hints: "tool" });
  assert.equal(!ambiguous.ok && ambiguous.error.message, "More than one of your question cards starts with 1a2b3c4d");
  assert.equal(!ambiguous.ok && ambiguous.error.nextAction, "Pass more characters.", "a step with no CLI command stays the Server's");
  for (const outcome of [tool, ambiguous]) assert.doesNotMatch(outcome.text, /\braft [a-z]/);
});

test("question cards: the two prepare limits read apart — per conversation (answer or withdraw first), per hour (wait retryAfterSeconds, then it may go again)", async () => {
  const refused = (status: number, body: Record<string, unknown>) => client(() => Response.json(body, { status }));
  const open = await prepareActionCard(refused(409, {
    error: "You already have 3 unanswered question cards in this conversation.", errorCode: "TOO_MANY_OPEN_QUESTIONS",
    suggestedNextAction: "Wait for an answer, or withdraw one you no longer need (raft action withdraw), before asking another here.",
  }), { target: "#ops", action: QUESTION } as never);
  assert.ok(!open.ok);
  assert.deepEqual([open.error.serverCode, open.error.message, open.error.retryable, open.error.retryAfterSeconds],
    ["TOO_MANY_OPEN_QUESTIONS", "You already have 3 unanswered question cards in this conversation.", false, undefined]);
  const hourly = await prepareActionCard(refused(429, {
    error: "You posted 30 question cards in the last hour, the most an agent may.", errorCode: "QUESTION_RATE_LIMITED",
    suggestedNextAction: "Wait 12 minutes (retryAfterSeconds: 700) before preparing another question card, or put your questions in one card when you do.",
    limit: 30, windowSeconds: 3600, retryAfterSeconds: 700,
  }), { target: "#ops", action: QUESTION } as never);
  assert.ok(!hourly.ok);
  // The Server's sentence and step (not a generic "rejected"), and the wait.
  assert.deepEqual([hourly.error.serverCode, hourly.error.message, hourly.error.retryable, hourly.error.retryAfterSeconds, hourly.error.nextAction], [
    "QUESTION_RATE_LIMITED", "You posted 30 question cards in the last hour, the most an agent may.", true, 700,
    "Wait 12 minutes (retryAfterSeconds: 700) before preparing another question card, or put your questions in one card when you do.",
  ]);
  assert.match(hourly.text, /Retryable: yes/);
  // A 429 without a usable wait keeps the sentence but is not said to be retryable.
  const noWait = await prepareActionCard(refused(429, { error: "Slow down.", errorCode: "QUESTION_RATE_LIMITED", retryAfterSeconds: 0 }), { target: "#ops", action: QUESTION } as never);
  assert.ok(!noWait.ok);
  assert.deepEqual([noWait.error.message, noWait.error.retryable, noWait.error.retryAfterSeconds], ["Slow down.", false, undefined]);
});
