// Synthetic host/API checks the built Web entry, not a native App.
// Run with `pnpm --filter @botiverse/raft-web test:feedback-diagnostics`.
// Full Test workflow runs this once, in E2E shard 1's Playwright container.
import { chromium, webkit } from '@playwright/test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname } from 'node:path';

const root = resolve('dist');
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const file = resolve(root, '.' + url.pathname + (url.pathname.endsWith('/') ? 'index.html' : ''));
  if (!file.startsWith(root + '/')) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(file);
    res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' })[extname(file)] ?? 'application/octet-stream');
    res.end(body);
  } catch { res.writeHead(404).end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
const ticket = {
  id: 'synthetic-ticket', kind: 'feedback', status: 'open', closure_reason: null,
  duplicate_of_ticket_id: null, message: 'Synthetic feedback',
  created_at: 1700000000000, updated_at: 1700000000000,
  unread: false, unread_count: 0, attachment_count: 1, comment_count: 0,
};
const evidenceDir = process.env.FEEDBACK_DIAGNOSTICS_EVIDENCE_DIR ?? resolve('dist/diagnostics-verification');
await mkdir(evidenceDir, { recursive: true });
const field = (body, key) => body.match(new RegExp(`name="${key}"\\r\\n\\r\\n([^\\r]+)`))?.[1];
const scenarios = [
  ['ordinary', 'brutal', 'light'], ['rejected', 'elegant', 'light'],
  ['skip', 'elegant', 'dark'], ['account', 'elegant', 'light'],
  ['edit', 'elegant', 'light'], ['editChanged', 'brutal', 'light'],
];

try {
  for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]]) {
    const browser = await engine.launch();
    try {
      for (const [scenario, theme, mode] of scenarios) {
        const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
        const errors = [];
        page.on('pageerror', e => errors.push(e.message));
        await page.addInitScript(({ origin, theme, mode }) => {
          window.__starts = []; window.__cancels = [];
          window.RaftFeedback = {
            version: 'raft-feedback-v1',
            session: {
              accountId: 'synthetic', sessionGeneration: 1, webViewGeneration: 1,
              accessToken: 'synthetic-token', apiOrigin: origin, clientKind: 'android',
              clientVersion: '1', locale: 'en', theme, mode,
            },
            emit: () => {}, capabilities: ['diagnostics-upload-v1'],
            diagnostics: {
              start: ({ requestId }, binding) => window.__starts.push({ requestId, binding }),
              cancel: ({ requestId }) => window.__cancels.push(requestId),
            },
          };
        }, { origin, theme, mode });
        const posts = [];
        await page.route('**/api/product-feedback**', async route => {
          const req = route.request();
          if (req.method() === 'POST') {
            posts.push(req.postDataBuffer().toString());
            if (posts.length === 1 && ['ordinary', 'rejected', 'edit', 'editChanged'].includes(scenario)) {
              await route.fulfill({ status: 400, json: { code: scenario === 'rejected' ? 'feedback_diagnostics_rejected' : 'feedback_invalid' } });
            } else await route.fulfill({ json: { id: ticket.id } });
            return;
          }
          await route.fulfill({ json: req.url().includes('/tickets/synthetic-ticket')
            ? { ticket, comments: [], attachments: [], next_comment_cursor: null, unread_total: 0 }
            : { tickets: [], next_cursor: null, unread_total: 0 } });
        });
        const emit = async type => page.evaluate(type => {
          const request = window.__starts.at(-1);
          window.dispatchEvent(new CustomEvent('raft:feedback-diagnostics', { detail: {
            ...request, type,
            ...(type === 'progress' ? { sent: 5, total: 12 } : { ref: {
              r2_key: 'feedback/synthetic/presigned/11111111-1111-4111-8111-111111111111-diagnostics.zip',
              filename: 'diagnostics.zip', content_type: 'application/zip', size: 12,
            } }),
          } }));
        }, type);
        await page.goto(origin + '/feedback/');
        await page.getByRole('button', { name: 'New feedback', exact: true }).click();
        // FeedbackWorkspace schedules focus on the new form's heading. Let
        // that navigation finish before WebKit's fill focuses and inserts text.
        await page.waitForFunction(() => document.activeElement?.matches('section:not([hidden]) h2'));
        await page.locator('textarea').fill('Synthetic feedback');
        await page.getByRole('button', { name: 'Send feedback', exact: true }).click();
        await page.waitForFunction(() => window.__starts.length === 1);
        await emit('progress');
        await page.getByRole('progressbar').waitFor();
        await page.screenshot({ path: `${evidenceDir}/${name}-${scenario}.png` });

        if (scenario === 'account') {
          await page.evaluate(() => {
            window.RaftFeedback.session.accountId = 'another';
            window.dispatchEvent(new Event('raft:feedback-session-updated'));
          });
          await emit('done');
          await page.locator('.feedback-host-status').waitFor();
          assert.equal(posts.length, 0);
        } else {
          if (scenario === 'skip') await page.getByRole('button', { name: 'Skip log and submit', exact: true }).click();
          else await emit('done');
          if (scenario === 'ordinary') {
            await page.getByRole('button', { name: 'Retry submission', exact: true }).waitFor();
            assert.equal(await page.getByRole('button', { name: 'Submit without diagnostic log', exact: true }).count(), 0);
            await page.getByRole('button', { name: 'Retry submission', exact: true }).click();
          } else if (scenario === 'rejected') {
            await page.getByRole('button', { name: 'Submit without diagnostic log', exact: true }).click();
          } else if (scenario === 'edit' || scenario === 'editChanged') {
            await page.getByRole('button', { name: 'Return to editing', exact: true }).click();
            const draft = page.locator('textarea');
            await draft.waitFor();
            assert.equal(await draft.inputValue(), 'Synthetic feedback');
            assert.equal(posts.length, 1);
            assert.equal(await draft.evaluate(el => !!el.closest('[inert]')), false);
            if (scenario === 'editChanged') await draft.fill('Edited synthetic feedback');
            await page.getByRole('button', { name: 'Send feedback', exact: true }).click();
            if (scenario === 'editChanged') {
              await page.waitForFunction(() => window.__starts.length === 2);
              await emit('done');
            }
          }
          await page.getByText('Synthetic feedback', { exact: true }).filter({ visible: true }).first().waitFor();
          assert.equal(posts.length, scenario === 'skip' ? 1 : 2);
          if (scenario === 'ordinary' || scenario === 'edit') {
            assert(field(posts[0], 'submission_id')); assert(field(posts[0], 'diagnostics'));
            for (const key of ['submission_id', 'diagnostics', 'message', 'metadata']) assert.equal(field(posts[0], key), field(posts[1], key));
          }
          if (scenario === 'editChanged') {
            assert.notEqual(field(posts[0], 'submission_id'), field(posts[1], 'submission_id'));
            assert.equal(field(posts[1], 'message'), 'Edited synthetic feedback');
          }
          if (scenario === 'rejected') {
            assert.notEqual(field(posts[0], 'submission_id'), field(posts[1], 'submission_id'));
            assert(field(posts[0], 'diagnostics')); assert.equal(field(posts[1], 'diagnostics'), undefined);
          }
          if (scenario === 'skip') assert.equal(field(posts[0], 'diagnostics'), undefined);
          await emit('done'); // A duplicate completion must not make another ticket.
          assert.equal(posts.length, scenario === 'skip' ? 1 : 2);
        }
        assert.equal(await page.evaluate(() => window.__starts.length), scenario === 'editChanged' ? 2 : 1);
        assert.deepEqual(errors, []);
        console.log(`${name} ${scenario}: PASS`);
        await page.close();
      }
    } finally { await browser.close(); }
  }
} finally { await new Promise(done => server.close(done)); }
