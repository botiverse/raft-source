import assert from "node:assert/strict";

import {
  createWeChatBridgeCredentialCipher,
  WECHAT_BRIDGE_CREDENTIAL_AAD_VERSION,
  WECHAT_BRIDGE_CREDENTIAL_KEY_ENV,
  WECHAT_BRIDGE_CREDENTIAL_KEY_ID_ENV,
  WECHAT_BRIDGE_DEFAULT_CREDENTIAL_KEY_ID,
  wechatBridgeCredentialCipher,
} from "./wechatBridgeCredentialCipher";
import type { ILinkBotId, ILinkBotToken } from "./wechatILinkClient";

// The WeChat bridge's bot tokens at rest: an AES-256-GCM envelope whose AAD
// names the binding, its owner and its bot, under a named key.

const TOKEN = "ilink-bot-token-0123456789" as ILinkBotToken;
const AUTHORITY = {
  bindingId: "11111111-1111-4111-8111-111111111111",
  userId: "22222222-2222-4222-8222-222222222222",
  ilinkBotId: "bot-abc@im.bot" as ILinkBotId,
};

function cipher(fill = 7, keyId = "env:WECHAT_BRIDGE_CREDENTIAL_ENCRYPTION_KEY:v1") {
  return createWeChatBridgeCredentialCipher({ key: Buffer.alloc(32, fill), keyId });
}

test("a sealed token opens under the same key, key id and authority, and the envelope does not contain it", () => {
  const sealed = cipher().seal({ ...AUTHORITY, botToken: TOKEN });
  assert.equal(sealed.envelopeKeyId, "env:WECHAT_BRIDGE_CREDENTIAL_ENCRYPTION_KEY:v1");
  assert.equal(sealed.aadVersion, WECHAT_BRIDGE_CREDENTIAL_AAD_VERSION);
  assert.match(sealed.encryptedBotToken, /^env-aes-256-gcm:v1:/);
  assert.ok(!sealed.encryptedBotToken.includes(TOKEN));
  assert.ok(!Buffer.from(sealed.encryptedBotToken.slice("env-aes-256-gcm:v1:".length), "base64url").toString("utf8").includes(TOKEN));
  assert.equal(cipher().unseal({ ...AUTHORITY, ...sealed }), TOKEN);
  // A fresh IV each time.
  assert.notEqual(cipher().seal({ ...AUTHORITY, botToken: TOKEN }).encryptedBotToken, sealed.encryptedBotToken);
});

test("any AAD mismatch (another binding, owner or bot) does not open it", () => {
  const sealed = cipher().seal({ ...AUTHORITY, botToken: TOKEN });
  assert.equal(cipher().unseal({ ...AUTHORITY, ...sealed, bindingId: "33333333-3333-4333-8333-333333333333" }), null);
  assert.equal(cipher().unseal({ ...AUTHORITY, ...sealed, userId: "44444444-4444-4444-8444-444444444444" }), null);
  assert.equal(cipher().unseal({ ...AUTHORITY, ...sealed, ilinkBotId: "other@im.bot" as ILinkBotId }), null);
  assert.equal(cipher().unseal({ ...AUTHORITY, ...sealed, aadVersion: 2 }), null);
});

test("a token sealed under another key id, or another key, does not open", () => {
  const sealed = cipher().seal({ ...AUTHORITY, botToken: TOKEN });
  // Rotated: same bytes, new id: the old rows answer null (their owners scan again).
  assert.equal(cipher(7, "env:WECHAT_BRIDGE_CREDENTIAL_ENCRYPTION_KEY:v2").unseal({ ...AUTHORITY, ...sealed }), null);
  // A row that claims the current id but was sealed under another key.
  assert.equal(cipher(8).unseal({ ...AUTHORITY, ...sealed }), null);
  // Tampered or foreign envelopes.
  const flipped = sealed.encryptedBotToken.slice(0, -2) + (sealed.encryptedBotToken.endsWith("A") ? "BB" : "AA");
  assert.equal(cipher().unseal({ ...AUTHORITY, ...sealed, encryptedBotToken: flipped }), null);
  assert.equal(cipher().unseal({ ...AUTHORITY, ...sealed, encryptedBotToken: "plain-token" }), null);
});

test("seal refuses an empty token or authority; the key must be 32 bytes and the key id well formed", () => {
  assert.throws(() => cipher().seal({ ...AUTHORITY, botToken: "" as ILinkBotToken }), /authority is invalid/);
  assert.throws(() => cipher().seal({ ...AUTHORITY, userId: "", botToken: TOKEN }), /authority is invalid/);
  assert.throws(() => createWeChatBridgeCredentialCipher({ key: Buffer.alloc(16, 1), keyId: "k" }), /32-byte key/);
  assert.throws(() => createWeChatBridgeCredentialCipher({ key: Buffer.alloc(32, 1), keyId: "bad id" }), /key id is invalid/);
});

test("the deployment cipher comes from the env; none (bridge unavailable) when the key is missing or malformed", () => {
  const key = Buffer.alloc(32, 5).toString("base64");
  const fromEnv = wechatBridgeCredentialCipher({ [WECHAT_BRIDGE_CREDENTIAL_KEY_ENV]: key });
  assert.ok(fromEnv);
  assert.equal(fromEnv.keyId, WECHAT_BRIDGE_DEFAULT_CREDENTIAL_KEY_ID);
  const sealed = fromEnv.seal({ ...AUTHORITY, botToken: TOKEN });
  assert.equal(createWeChatBridgeCredentialCipher({ key: Buffer.alloc(32, 5), keyId: WECHAT_BRIDGE_DEFAULT_CREDENTIAL_KEY_ID }).unseal({ ...AUTHORITY, ...sealed }), TOKEN);
  assert.equal(wechatBridgeCredentialCipher({ [WECHAT_BRIDGE_CREDENTIAL_KEY_ENV]: key, [WECHAT_BRIDGE_CREDENTIAL_KEY_ID_ENV]: "env:rotated:v2" })?.keyId, "env:rotated:v2");
  assert.equal(wechatBridgeCredentialCipher({}), null);
  assert.equal(wechatBridgeCredentialCipher({ [WECHAT_BRIDGE_CREDENTIAL_KEY_ENV]: "too-short" }), null);
});
