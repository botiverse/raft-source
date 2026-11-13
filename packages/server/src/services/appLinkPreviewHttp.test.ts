import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { vi, afterEach } from "vitest";
const mocked = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: mocked.lookup }));
vi.mock('node:https', async (original) => ({ ...await original<typeof import('node:https')>(), request: mocked.request }));
import { PreviewNotSentError, previewHttp } from "./appLinkPreviewHttp";
afterEach(() => { mocked.lookup.mockReset(); mocked.request.mockReset(); });
test('preview transport refuses private DNS results before sending identity or a request', async () => {
  mocked.lookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
  await assert.rejects(previewHttp('https://app.example/callback', '{}', 'synthetic-assertion'), /unavailable/);
  assert.equal(mocked.request.mock.calls.length, 0);
  await assert.rejects(previewHttp('http://app.example/callback'), /Invalid/);
});
test('preview transport pins public DNS and rejects redirects instead of forwarding its assertion', async () => {
  mocked.lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
  mocked.request.mockImplementation((options, onResponse) => {
    assert.equal(options.hostname, 'app.example'); assert.equal(options.headers.authorization, 'Bearer synthetic-assertion');
    assert.equal(options.rejectUnauthorized, true); assert.equal(typeof options.lookup, 'function');
    const req = new EventEmitter() as EventEmitter & { end: () => void; destroy: (error?: Error) => void };
    req.destroy = (error) => { if (error) req.emit('error', error); req.emit('close'); };
    req.end = () => onResponse({ statusCode: 302, headers: { location: 'https://another.example/' }, resume() {} });
    return req;
  });
  await assert.rejects(previewHttp('https://app.example/callback', '{}', 'synthetic-assertion'), /unavailable/);
  assert.equal(mocked.request.mock.calls.length, 1);
});
test('preview transport bounds streamed JSON before parsing it', async () => {
  mocked.lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
  mocked.request.mockImplementation((_options, onResponse) => {
    const req = new EventEmitter() as EventEmitter & { end: () => void; destroy: (error?: Error) => void };
    const res = new EventEmitter() as EventEmitter & { statusCode: number; headers: object; destroy: (error: Error) => void };
    res.statusCode = 200; res.headers = { 'content-type': 'application/json' };
    res.destroy = (error) => res.emit('error', error);
    req.destroy = (error) => { if (error) req.emit('error', error); req.emit('close'); };
    req.end = () => { onResponse(res); res.emit('data', Buffer.alloc(32769)); };
    return req;
  });
  await assert.rejects(previewHttp('https://app.example/proof'), /too large/);
});

/** A transport that answers 200 application/json with `body`, recording the request options. */
function answering(body: string | Buffer) {
  mocked.lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
  const sent: { headers: Record<string, unknown> }[] = [];
  mocked.request.mockImplementation((options, onResponse) => {
    sent.push(options);
    const req = new EventEmitter() as EventEmitter & { end: () => void; destroy: (error?: Error) => void };
    const res = new EventEmitter() as EventEmitter & { statusCode: number; headers: object; destroy: (error: Error) => void };
    res.statusCode = 200; res.headers = { 'content-type': 'application/json; charset=utf-8' };
    res.destroy = (error) => res.emit('error', error);
    req.destroy = (error) => { if (error) req.emit('error', error); req.emit('close'); };
    req.end = () => { onResponse(res); res.emit('data', Buffer.isBuffer(body) ? body : Buffer.from(body)); res.emit('end'); };
    return req;
  });
  return sent;
}
// Protocol addendum 4 §4: a key with a C0 control character makes a preview
// answer invalid, v1 included. v1 keeps JSON.parse, so the raw text is checked first.
const c0Answer = '{"version":1,"title":"x","card":{"root":"a","elements":{"a":{"type":"Badge","props":{"text":"y"}},"\\u001b":{"type":"Badge","props":{"text":"z"}}}}}';
test('a v1 preview answer with a C0 key is refused before JSON.parse; values may hold control characters', async () => {
  answering(c0Answer);
  await assert.rejects(previewHttp('https://app.example/callback', '{}', 'synthetic-assertion', { response: 'preview' }), /Invalid preview JSON/);
  answering('{"version":1,"title":"line1\\nline2\\u001b"}');
  assert.deepEqual(await previewHttp('https://app.example/callback', '{}', 'synthetic-assertion', { response: 'preview' }), { version: 1, title: 'line1\nline2\u001b' });
  // The domain proof is not protocol JSON: the rule does not apply there.
  answering('{"client_id":"app","\\t":"x"}');
  assert.deepEqual(await previewHttp('https://app.example/.well-known/raft-link-preview.json'), { client_id: 'app', '\t': 'x' });
});
test('K6 for v1: a native JSON.parse that corrupts the key does not let the answer through', async () => {
  const parse = vi.spyOn(JSON, 'parse').mockImplementation(() => ({ version: 1, title: 'x', '\\': 'corrupted' }));
  try {
    answering(c0Answer);
    await assert.rejects(previewHttp('https://app.example/callback', '{}', 'synthetic-assertion', { response: 'preview' }), /Invalid preview JSON/);
    assert.equal(parse.mock.calls.length, 0, 'refused before JSON.parse ran');
  } finally { parse.mockRestore(); }
});
test('a v2 callback gets the raw text (strict UTF-8, never JSON.parse) and sends Accept-Language', async () => {
  const sent = answering('{"version":2,"display":"link","display":"card"}');
  assert.equal(await previewHttp('https://app.example/callback', '{}', 'synthetic-assertion', { response: 'text', acceptLanguage: 'zh-CN' }), '{"version":2,"display":"link","display":"card"}');
  assert.equal(sent[0]!.headers['accept-language'], 'zh-CN');
  const plain = answering('{}');
  await previewHttp('https://app.example/callback', '{}', 'synthetic-assertion', { response: 'preview' });
  assert.equal(plain[0]!.headers['accept-language'], undefined, 'v1 sends no Accept-Language');
  answering(Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]));
  await assert.rejects(previewHttp('https://app.example/callback', '{}', 'synthetic-assertion', { response: 'text' }), /Invalid preview JSON/, 'invalid UTF-8 is refused, not replaced');
});

// Card actions (protocol v3.2.3 §8.1): only a failure before any request was
// created proves nothing was sent; anything later may have been.
test('a refusal before a request exists is PreviewNotSentError; a failure after one is not', async () => {
  mocked.lookup.mockResolvedValue([{ address: '10.0.0.7', family: 4 }]);
  await assert.rejects(previewHttp('https://app.example/card-actions', '{}', 'a'), PreviewNotSentError, 'private address');
  mocked.lookup.mockRejectedValue(Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }));
  await assert.rejects(previewHttp('https://app.example/card-actions', '{}', 'a'), PreviewNotSentError, 'DNS failure');
  await assert.rejects(previewHttp('http://app.example/card-actions', '{}', 'a'), PreviewNotSentError, 'not a public HTTPS endpoint');
  assert.equal(mocked.request.mock.calls.length, 0);
  mocked.lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
  mocked.request.mockImplementation((_options, onResponse) => {
    const req = new EventEmitter() as EventEmitter & { end: () => void; destroy: (error?: Error) => void };
    req.destroy = (error) => { if (error) req.emit('error', error); req.emit('close'); };
    req.end = () => onResponse({ statusCode: 500, headers: {}, resume() {} });
    return req;
  });
  await assert.rejects(previewHttp('https://app.example/card-actions', '{}', 'a'), (error: Error) => !(error instanceof PreviewNotSentError));
});
test('timeoutMs bounds the whole exchange (card actions pass 2.5 s; previews keep 3 s)', async () => {
  mocked.lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
  mocked.request.mockImplementation(() => {
    const req = new EventEmitter() as EventEmitter & { end: () => void; destroy: (error?: Error) => void };
    req.destroy = (error) => { if (error) req.emit('error', error); req.emit('close'); };
    req.end = () => undefined; // never answers
    return req;
  });
  const started = Date.now();
  await assert.rejects(previewHttp('https://app.example/card-actions', '{}', 'a', { timeoutMs: 80, response: 'text' }), /timeout/);
  assert.ok(Date.now() - started < 2000);
});
