import "./helpers/domSetup";
import assert from "node:assert/strict";
import { sanitizeClonedMessageForScreenshot } from "../src/utils/selectScreenshot";

test("replaces concrete attachments with a compact filename-only summary", () => {
  const clone = document.createElement("div");
  clone.innerHTML = `
    <div data-select-screenshot-attachment-content="true"><img alt="secret preview"></div>
    <div class="hidden" aria-hidden="true" data-select-screenshot-attachment-summary="true">
      <span>report.pdf</span><span>diagram.png</span>
    </div>
  `;

  sanitizeClonedMessageForScreenshot(clone);

  assert.ok(clone.querySelector("[data-select-screenshot-attachment-content]") === null);
  const summary = clone.querySelector<HTMLElement>("[data-select-screenshot-attachment-summary]");
  assert.ok(summary);
  assert.equal(summary.classList.contains("hidden"), false);
  assert.equal(summary.getAttribute("aria-hidden"), null);
  assert.match(summary.textContent ?? "", /report\.pdf/);
  assert.match(summary.textContent ?? "", /diagram\.png/);
});

test("keeps inline task reference text but removes footer task status and source chrome", () => {
  const clone = document.createElement("div");
  clone.innerHTML = `
    <button data-message-affordance="open-linked-task"><svg data-task-status-icon="true"></svg><span>#1303</span></button>
    <button data-message-affordance="open-linked-task"><span data-testid="message-task-badge">in progress</span></button>
    <button data-message-affordance="saved-badge">Saved</button>
    <button data-message-affordance="read-receipt">Read</button>
    <button data-message-affordance="reaction-add">+</button>
    <span data-select-screenshot-reaction="true" data-testid="reaction">👍 2</span>
  `;

  sanitizeClonedMessageForScreenshot(clone);

  assert.match(clone.textContent ?? "", /task #1303/);
  assert.doesNotMatch(clone.textContent ?? "", /in progress|Saved|Read|\+|👍 2/);
  assert.ok(clone.querySelector("[data-message-affordance]") === null);
  assert.ok(clone.querySelector("[data-select-screenshot-reaction]") === null);
  assert.ok(clone.querySelector("[data-task-status-icon]") === null);
  assert.ok(clone.querySelector("[data-select-screenshot-static-ref]"));
});

test("keeps the real sender avatar while removing persisted reactions", () => {
  const clone = document.createElement("div");
  clone.innerHTML = `
    <img data-testid="message-sender-avatar" alt="Cindy" src="data:image/png;base64,AA==">
    <span data-select-screenshot-reaction="true"><button>👍 4</button></span>
  `;

  sanitizeClonedMessageForScreenshot(clone);

  assert.ok(clone.querySelector('[data-testid="message-sender-avatar"]'));
  assert.doesNotMatch(clone.textContent ?? "", /👍 4/);
  assert.ok(clone.querySelector("[data-select-screenshot-reaction]") === null);
});

test("removes human role labels while preserving agent model and description", () => {
  const clone = document.createElement("div");
  clone.innerHTML = `
    <span data-select-screenshot-human-role="true">Owner</span>
    <span data-testid="message-sender-model-agent-1">GPT-5 Codex</span>
    <span>Turns product feedback into actionable UX specs.</span>
  `;

  sanitizeClonedMessageForScreenshot(clone);

  assert.ok(clone.querySelector("[data-select-screenshot-human-role]") === null);
  assert.doesNotMatch(clone.textContent ?? "", /Owner/);
  assert.match(clone.textContent ?? "", /GPT-5 Codex/);
  assert.match(clone.textContent ?? "", /Turns product feedback/);
});

test("reduces action cards to their static title and completed-result summary", () => {
  const clone = document.createElement("div");
  clone.innerHTML = `
    <article data-select-screenshot-action-card="true">
      <header>
        <span>Create channel</span>
        <span>Completed by Cindy · #general</span>
        <span data-select-screenshot-action-control="true">Done</span>
        <button data-select-screenshot-action-control="true">Collapse</button>
      </header>
      <section data-select-screenshot-action-detail="true">
        <p>Runtime-only scopes and properties</p>
        <button>Run action</button>
      </section>
    </article>
  `;

  sanitizeClonedMessageForScreenshot(clone);

  assert.match(clone.textContent ?? "", /Create channel/);
  assert.match(clone.textContent ?? "", /Completed by Cindy/);
  assert.doesNotMatch(clone.textContent ?? "", /Done|Collapse|Runtime-only|Run action/);
  assert.ok(clone.querySelector("[data-select-screenshot-action-detail]") === null);
  assert.ok(clone.querySelector("[data-select-screenshot-action-control]") === null);
});
