import { isSlackVerifiedIngressAad, type SlackVerifiedIngressAad, type SlackVerifiedIngressPayloadCrypto } from "./slackVerifiedIngressContracts";
import { openSlackVerifiedIngress, sealSlackVerifiedIngress } from "./slackVerifiedIngressCrypto";

/** Use the existing encrypted-payload key with a distinct authenticated purpose. */
export function createSlackVerifiedIngressEnvCrypto(input: {
  key: Buffer;
  keyId: string;
  decryptionKeys?: ReadonlyMap<string, Buffer>;
  registrationId: string;
  environment: "test" | "production";
  providerAppId: string;
}): SlackVerifiedIngressPayloadCrypto {
  if (!Buffer.isBuffer(input.key) || input.key.length !== 32 || !/^[A-Za-z0-9:_./-]{1,320}$/u.test(input.keyId)
    || !input.registrationId.trim() || !input.providerAppId.trim()) {
    throw new Error("Invalid Slack ingress encryption configuration");
  }
  const key = Buffer.from(input.key);
  const { keyId, registrationId, environment, providerAppId } = input;
  const readKeys = new Map<string, Buffer>([[keyId, key]]);
  for (const [id, candidate] of input.decryptionKeys ?? []) {
    if (!/^[A-Za-z0-9:_./-]{1,320}$/u.test(id) || !Buffer.isBuffer(candidate) || candidate.length !== 32
      || (id === keyId && !candidate.equals(key))) throw new Error("Invalid Slack ingress encryption configuration");
    readKeys.set(id, Buffer.from(candidate));
  }
  const verifyAuthority = (aad: SlackVerifiedIngressAad) => {
    if (!isSlackVerifiedIngressAad(aad) || aad.registrationId !== registrationId
      || aad.environment !== environment || aad.providerAppId !== providerAppId) {
      throw new Error("Invalid Slack ingress encryption authority");
    }
  };
  return {
    async seal(request) {
      verifyAuthority(request.aad);
      return { encryptedPayload: sealSlackVerifiedIngress({ bytes: request.bytes, key, aad: request.aad }),
        envelopeKeyId: keyId };
    },
    async open(request) {
      verifyAuthority(request.aad);
      const readKey = readKeys.get(request.envelopeKeyId);
      if (!readKey) throw new Error("Invalid Slack ingress encryption key");
      return openSlackVerifiedIngress({ envelope: request.encryptedPayload, key: readKey, aad: request.aad });
    },
  };
}
