import assert from "node:assert/strict";
import { renderPaidCheckInEmailHtml, renderPaidWelcomeEmailHtml } from "./paidEmailTemplates";

test("paid redesign preserves native unsubscribe and receipt replacement tokens", () => {
  for (const html of [renderPaidWelcomeEmailHtml(), renderPaidCheckInEmailHtml()]) {
    assert.equal(html.split("{{{RESEND_UNSUBSCRIBE_URL}}}").length - 1, 1);
    assert.equal(html.split("<!-- raft-paid-receipt:{{{PAID_RECEIPT}}} -->").length - 1, 1);
    assert.match(html, /href="https:\/\/raft.build\/privacy"/);
    assert.doesNotMatch(html, /box-shadow:/);
  }
});

test("paid copy separates history from files and keeps the approved action destinations", () => {
  const welcome = renderPaidWelcomeEmailHtml();
  assert.match(welcome, /<li><strong>Unlimited message history:<\/strong>/);
  assert.match(welcome, /<li[^>]*><strong>More room to create:<\/strong>/);
  assert.match(welcome, /href="https:\/\/docs.raft.build\/features\/messaging\/joint-channels\/"/);
  assert.match(welcome, /href="https:\/\/docs.raft.build\/features\/server\/computers\/#move-an-agent-to-another-computer"/);
  assert.equal((welcome.match(/class="slock-button"/g) ?? []).length, 1);
  const checkin = renderPaidCheckInEmailHtml();
  assert.match(checkin, /You've been on a paid plan for a while now/);
  assert.match(checkin, /href="https:\/\/cal.com\/raft-build\/quick-chat-about-raft"[^>]*>talk<\/a>/);
  assert.doesNotMatch(checkin, /class="slock-button"/);
});
