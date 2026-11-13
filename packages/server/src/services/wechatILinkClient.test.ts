import assert from "node:assert/strict";

import {
  buildGetUpdatesRequest,
  buildSendTextMessageRequest,
  createWeChatILinkClient,
  encodeILinkClientVersion,
  ilinkOriginFromRedirectHost,
  ILINK_APP_CLIENT_VERSION,
  ILINK_APP_ID,
  ILINK_DEFAULT_BASE_URL,
  ILINK_MAX_LONG_POLL_MS,
  ILINK_QR_STATUSES,
  ILinkRequestError,
  ILinkStaleTokenError,
  normalizeILinkOrigin,
  parseGetUpdatesResponse,
  parseSendMessageResponse,
  type ILinkBotToken,
  type ILinkQrcodeHandle,
  type ILinkTransport,
  type ILinkUserId,
  type WeChatContextToken,
} from "./wechatILinkClient";

// The iLink (WeChat ClawBot) client against a fake transport: the host
// allowlist, the protocol's headers, every QR status, and the -14 stale token.

type Call = { url: string; method: string; headers: Record<string, string>; body?: string };

function fake(answer: (call: Call) => Response | Promise<Response>): { transport: ILinkTransport; calls: Call[] } {
  const calls: Call[] = [];
  const transport: ILinkTransport = async (url, init) => {
    const call = { url, method: init.method, headers: init.headers, body: init.body };
    calls.push(call);
    return answer(call);
  };
  return { transport, calls };
}

const TOKEN = "bot-token-xyz" as ILinkBotToken;
const qr = (handle: string) => handle as ILinkQrcodeHandle;
const user = (id: string) => id as ILinkUserId;

test("the allowlist takes https:443 ilinkai.weixin.qq.com or *.ilinkai.weixin.qq.com only, and keeps just the origin", () => {
  assert.equal(normalizeILinkOrigin("https://ilinkai.weixin.qq.com"), "https://ilinkai.weixin.qq.com");
  assert.equal(normalizeILinkOrigin("https://ILINKAI.weixin.qq.com/ilink/bot?x=1#y"), "https://ilinkai.weixin.qq.com");
  assert.equal(normalizeILinkOrigin("https://sh.ilinkai.weixin.qq.com:443/"), "https://sh.ilinkai.weixin.qq.com");
  for (const refused of [
    "https://other.weixin.qq.com",
    "https://liteapp.weixin.qq.com",
    "https://xilinkai.weixin.qq.com",
    "https://weixin.qq.com.evil.com",
    "https://ilinkai.weixin.qq.com.evil.com",
    "https://evilweixin.qq.com",
    "https://weixin.qq.com",
    "https://qq.com",
    "http://ilinkai.weixin.qq.com",
    "https://ilinkai.weixin.qq.com:8443",
    "https://user:pass@ilinkai.weixin.qq.com",
    "https://user@ilinkai.weixin.qq.com",
    "https://1.2.3.4",
    "https://[::1]",
    "https://ilinkai.weixin.qq.com.",
    "ftp://ilinkai.weixin.qq.com",
    "ilinkai.weixin.qq.com",
    "",
    42,
  ]) {
    assert.equal(normalizeILinkOrigin(refused), null, String(refused));
  }
  assert.equal(ilinkOriginFromRedirectHost("sz.ilinkai.weixin.qq.com"), "https://sz.ilinkai.weixin.qq.com");
  for (const refused of ["evil.com", "weixin.qq.com.evil.com", "other.weixin.qq.com", "a.ilinkai.weixin.qq.com:8443", "a.ilinkai.weixin.qq.com/path", "u@a.ilinkai.weixin.qq.com", "10.0.0.1", ""]) {
    assert.equal(ilinkOriginFromRedirectHost(refused), null, refused);
  }
});

test("get_bot_qrcode: POST to the fixed host with the protocol headers and no Authorization", async () => {
  const { transport, calls } = fake(() => Response.json({ qrcode: "qr-handle", qrcode_img_content: "https://weixin.qq.com/x/abc" }));
  const qr = await createWeChatILinkClient({ transport }).getBotQrcode();
  assert.deepEqual(qr, { qrcode: "qr-handle", qrContent: "https://weixin.qq.com/x/abc" });
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call!.method, "POST");
  assert.equal(call!.url, `${ILINK_DEFAULT_BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=3`);
  assert.deepEqual(JSON.parse(call!.body!), { local_token_list: [] });
  assert.equal(call!.headers.AuthorizationType, "ilink_bot_token");
  assert.equal(call!.headers.Authorization, undefined);
  assert.equal(call!.headers["iLink-App-Id"], ILINK_APP_ID);
  assert.equal(call!.headers["iLink-App-ClientVersion"], ILINK_APP_CLIENT_VERSION);
  assert.equal(call!.headers["Content-Type"], "application/json");
  // X-WECHAT-UIN: base64 of a uint32 in decimal.
  assert.match(Buffer.from(call!.headers["X-WECHAT-UIN"]!, "base64").toString("utf8"), /^\d{1,10}$/);
  assert.equal(encodeILinkClientVersion("1.0.11"), 65547);
  assert.equal(ILINK_APP_CLIENT_VERSION, String((2 << 16) | (4 << 8) | 10));
});

test("get_qrcode_status: every status, application headers only, the verify code passed on", async () => {
  for (const status of ["wait", "scaned", "expired", "need_verifycode", "verify_code_blocked", "binded_redirect"] as const) {
    const { transport, calls } = fake(() => Response.json({ status }));
    assert.deepEqual(await createWeChatILinkClient({ transport }).getQrcodeStatus({ baseUrl: ILINK_DEFAULT_BASE_URL, qrcode: qr("q r") }), { status });
    assert.equal(calls[0]!.method, "GET");
    assert.equal(calls[0]!.url, `${ILINK_DEFAULT_BASE_URL}/ilink/bot/get_qrcode_status?qrcode=q%20r`);
    assert.deepEqual(Object.keys(calls[0]!.headers).sort(), ["iLink-App-ClientVersion", "iLink-App-Id"]);
  }
  assert.equal(ILINK_QR_STATUSES.length, 8);

  const verify = fake(() => Response.json({ status: "scaned" }));
  await createWeChatILinkClient({ transport: verify.transport }).getQrcodeStatus({ baseUrl: ILINK_DEFAULT_BASE_URL, qrcode: qr("q"), verifyCode: "1234" });
  assert.match(verify.calls[0]!.url, /&verify_code=1234$/);

  const redirect = fake(() => Response.json({ status: "scaned_but_redirect", redirect_host: "sz.ilinkai.weixin.qq.com" }));
  assert.deepEqual(
    await createWeChatILinkClient({ transport: redirect.transport }).getQrcodeStatus({ baseUrl: ILINK_DEFAULT_BASE_URL, qrcode: qr("q") }),
    { status: "scaned_but_redirect", redirectBaseUrl: "https://sz.ilinkai.weixin.qq.com" },
  );
  const noHost = fake(() => Response.json({ status: "scaned_but_redirect" }));
  assert.deepEqual(
    await createWeChatILinkClient({ transport: noHost.transport }).getQrcodeStatus({ baseUrl: ILINK_DEFAULT_BASE_URL, qrcode: qr("q") }),
    { status: "scaned_but_redirect", redirectBaseUrl: null },
  );

  const confirmed = fake(() => Response.json({
    status: "confirmed", bot_token: "tok", ilink_bot_id: "b@im.bot", ilink_user_id: "u@im.wechat", baseurl: "https://sh.ilinkai.weixin.qq.com/",
  }));
  assert.deepEqual(
    await createWeChatILinkClient({ transport: confirmed.transport }).getQrcodeStatus({ baseUrl: ILINK_DEFAULT_BASE_URL, qrcode: qr("q") }),
    { status: "confirmed", botToken: "tok", ilinkBotId: "b@im.bot", ilinkUserId: "u@im.wechat", baseUrl: "https://sh.ilinkai.weixin.qq.com" },
  );
  const noBase = fake(() => Response.json({ status: "confirmed", bot_token: "tok", ilink_bot_id: "b", ilink_user_id: "u" }));
  const answer = await createWeChatILinkClient({ transport: noBase.transport }).getQrcodeStatus({ baseUrl: ILINK_DEFAULT_BASE_URL, qrcode: qr("q") });
  assert.equal(answer.status === "confirmed" && answer.baseUrl, ILINK_DEFAULT_BASE_URL);
});

test("a returned baseurl or redirect_host off the allowlist is refused, and so is polling a host off it", async () => {
  for (const body of [
    { status: "confirmed", bot_token: "tok", ilink_bot_id: "b", ilink_user_id: "u", baseurl: "https://weixin.qq.com.evil.com" },
    { status: "confirmed", bot_token: "tok", ilink_bot_id: "b", ilink_user_id: "u", baseurl: "http://ilinkai.weixin.qq.com" },
    { status: "scaned_but_redirect", redirect_host: "evil.com" },
    { status: "scaned_but_redirect", redirect_host: "1.2.3.4" },
  ]) {
    const { transport } = fake(() => Response.json(body));
    await assert.rejects(
      createWeChatILinkClient({ transport }).getQrcodeStatus({ baseUrl: ILINK_DEFAULT_BASE_URL, qrcode: qr("q") }),
      (err: unknown) => err instanceof ILinkRequestError && err.kind === "host_not_allowed" && !String(err.message).includes("tok"),
      JSON.stringify(body),
    );
  }
  const { transport, calls } = fake(() => Response.json({ status: "wait" }));
  await assert.rejects(
    createWeChatILinkClient({ transport }).getQrcodeStatus({ baseUrl: "https://evil.example", qrcode: qr("q") }),
    (err: unknown) => err instanceof ILinkRequestError && err.kind === "host_not_allowed",
  );
  assert.equal(calls.length, 0, "nothing is sent to a host off the allowlist");
  // An incomplete confirmation or an unknown status is a protocol error, not a binding.
  for (const body of [{ status: "confirmed", bot_token: "tok", ilink_bot_id: "b" }, { status: "bound" }, ["wait"]]) {
    const bad = fake(() => Response.json(body));
    await assert.rejects(
      createWeChatILinkClient({ transport: bad.transport }).getQrcodeStatus({ baseUrl: ILINK_DEFAULT_BASE_URL, qrcode: qr("q") }),
      (err: unknown) => err instanceof ILinkRequestError && err.kind === "protocol",
    );
  }
});

test("transport failures are typed; a status poll that times out reads as wait", async () => {
  const http = fake(() => new Response("nope", { status: 502 }));
  await assert.rejects(createWeChatILinkClient({ transport: http.transport }).getBotQrcode(),
    (err: unknown) => err instanceof ILinkRequestError && err.kind === "http" && err.details.status === 502);
  const network = fake(() => { throw new TypeError("fetch failed"); });
  await assert.rejects(createWeChatILinkClient({ transport: network.transport }).getBotQrcode(),
    (err: unknown) => err instanceof ILinkRequestError && err.kind === "network");
  const timeout: ILinkTransport = async (_url, init) => {
    // Answers only when aborted: the request's own deadline.
    await new Promise<void>((resolve) => init.signal.addEventListener("abort", () => resolve()));
    throw new DOMException("aborted", "TimeoutError");
  };
  const controller = new AbortController();
  // Abort from outside to keep the test fast; an outside abort is a network failure, not `wait`.
  setTimeout(() => controller.abort(), 5);
  await assert.rejects(
    createWeChatILinkClient({ transport: timeout }).getQrcodeStatus({ baseUrl: ILINK_DEFAULT_BASE_URL, qrcode: qr("q"), signal: controller.signal }),
    (err: unknown) => err instanceof ILinkRequestError && err.kind === "network",
  );
});

test("getupdates and sendmessage: the bot's Authorization, base_info, and the text-only message shape", () => {
  const updates = buildGetUpdatesRequest({ baseUrl: "https://sh.ilinkai.weixin.qq.com", botToken: TOKEN, getUpdatesBuf: null });
  assert.equal(updates.url, "https://sh.ilinkai.weixin.qq.com/ilink/bot/getupdates");
  assert.equal(updates.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(updates.headers.AuthorizationType, "ilink_bot_token");
  assert.ok(updates.headers["X-WECHAT-UIN"]);
  const updatesBody = JSON.parse(updates.body!) as { get_updates_buf: string; base_info: { channel_version: string; bot_agent: string } };
  assert.equal(updatesBody.get_updates_buf, "");
  assert.equal(updatesBody.base_info.channel_version, "2.4.10");
  assert.ok(updates.timeoutMs > 35_000, "the deadline covers the long poll");
  // iLink's suggestion is honoured, but the deadline stays under the transport's 55 s backstop.
  const suggested = (longPollTimeoutMs: number) => buildGetUpdatesRequest({ baseUrl: ILINK_DEFAULT_BASE_URL, botToken: TOKEN, getUpdatesBuf: "b", longPollTimeoutMs }).timeoutMs;
  assert.ok(suggested(20_000) > 20_000 && suggested(20_000) < updates.timeoutMs, "a shorter suggestion shortens the deadline");
  assert.equal(suggested(120_000), ILINK_MAX_LONG_POLL_MS + 10_000);
  assert.ok(suggested(120_000) < 55_000, "never past the transport's backstop");

  const send = buildSendTextMessageRequest({
    baseUrl: ILINK_DEFAULT_BASE_URL, botToken: TOKEN, toUserId: user("u@im.wechat"), clientId: "raft-msg-1", contextToken: "ctx" as WeChatContextToken, text: "hi",
  });
  assert.equal(send.url, `${ILINK_DEFAULT_BASE_URL}/ilink/bot/sendmessage`);
  assert.deepEqual((JSON.parse(send.body!) as { msg: unknown }).msg, {
    from_user_id: "", to_user_id: "u@im.wechat", client_id: "raft-msg-1", message_type: 2, message_state: 2, context_token: "ctx",
    item_list: [{ type: 1, text_item: { text: "hi" } }],
  });
  assert.throws(() => buildSendTextMessageRequest({ baseUrl: "https://evil.example", botToken: TOKEN, toUserId: user("u"), clientId: "c", contextToken: null, text: "x" }),
    (err: unknown) => err instanceof ILinkRequestError && err.kind === "host_not_allowed");
});

test("getupdates parsing: messages, cursor, timeout; ret or errcode -14 is the stale-token error", () => {
  const parsed = parseGetUpdatesResponse(JSON.stringify({
    ret: 0,
    get_updates_buf: "cursor-2",
    longpolling_timeout_ms: 30000,
    msgs: [
      { message_id: 7001, from_user_id: "u@im.wechat", to_user_id: "b@im.bot", message_type: 1, create_time_ms: 1700000000000, context_token: "ctx-1",
        item_list: [{ type: 1, text_item: { text: "hello" } }, { type: 2, image_item: {} }] },
      { message_id: 2 ** 60, from_user_id: "u@im.wechat", item_list: [{ type: 3, voice_item: {} }] },
      "junk",
    ],
  }));
  assert.equal(parsed.getUpdatesBuf, "cursor-2");
  assert.equal(parsed.longPollingTimeoutMs, 30000);
  assert.equal(parsed.messages.length, 2);
  assert.deepEqual(parsed.messages[0], {
    messageId: "7001", fromUserId: "u@im.wechat", toUserId: user("b@im.bot"), messageType: 1, createTimeMs: 1700000000000,
    contextToken: "ctx-1", text: "hello", nonTextItemTypes: [2],
  });
  // Not a safe integer: no id (dedupe falls back to the context token), no text.
  assert.equal(parsed.messages[1]!.messageId, null);
  assert.equal(parsed.messages[1]!.text, null);
  assert.deepEqual(parsed.messages[1]!.nonTextItemTypes, [3]);
  assert.equal(parseGetUpdatesResponse(JSON.stringify({ ret: 0, msgs: [], get_updates_buf: "" })).getUpdatesBuf, null);

  assert.throws(() => parseGetUpdatesResponse(JSON.stringify({ ret: -14 })), ILinkStaleTokenError);
  assert.throws(() => parseGetUpdatesResponse(JSON.stringify({ ret: 0, errcode: -14, errmsg: "session timeout" })), ILinkStaleTokenError);
  assert.throws(() => parseSendMessageResponse(JSON.stringify({ ret: -14 })), ILinkStaleTokenError);
  assert.throws(() => parseGetUpdatesResponse(JSON.stringify({ ret: -1 })),
    (err: unknown) => err instanceof ILinkRequestError && !(err instanceof ILinkStaleTokenError) && err.kind === "business");
  assert.doesNotThrow(() => parseSendMessageResponse(JSON.stringify({ ret: 0, errmsg: "" })));
  assert.doesNotThrow(() => parseSendMessageResponse(""));
});

test("the client's getupdates and sendmessage go through the transport and surface -14 as stale", async () => {
  const { transport, calls } = fake((call) => call.url.endsWith("/getupdates")
    ? Response.json({ ret: 0, msgs: [], get_updates_buf: "c" })
    : Response.json({ ret: -14, errmsg: "expired" }));
  const client = createWeChatILinkClient({ transport });
  assert.deepEqual(await client.getUpdates({ baseUrl: ILINK_DEFAULT_BASE_URL, botToken: TOKEN, getUpdatesBuf: "b" }), { messages: [], getUpdatesBuf: "c", longPollingTimeoutMs: null });
  await assert.rejects(client.sendTextMessage({ baseUrl: ILINK_DEFAULT_BASE_URL, botToken: TOKEN, toUserId: user("u"), clientId: "c", contextToken: null, text: "x" }), ILinkStaleTokenError);
  assert.equal(calls.length, 2);
});
