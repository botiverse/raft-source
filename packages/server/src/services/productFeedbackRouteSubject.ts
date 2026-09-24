import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  timingSafeEqual,
} from "node:crypto";
import { productFeedbackReporterId } from "./productFeedbackService.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SUBJECT_RE = /^rfr_v1_[A-Za-z0-9_-]+$/;
const SALT = Buffer.from("raft-feedback-route:v1", "utf8");

export type FeedbackRouteCoordinate = {
  appId: string;
  reporterIntegrationId: string;
  reporterId: string;
};

export class ProductFeedbackRouteSubjectError extends Error {
  constructor() {
    super("invalid feedback route subject");
    this.name = "ProductFeedbackRouteSubjectError";
  }
}

export function feedbackRouteTuple(...fields: readonly (string | Buffer)[]): Buffer {
  const count = Buffer.alloc(4);
  count.writeUInt32BE(fields.length);
  const parts: Buffer[] = [count];
  for (const field of fields) {
    const bytes = Buffer.isBuffer(field) ? field : Buffer.from(field, "utf8");
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    parts.push(length, bytes);
  }
  return Buffer.concat(parts);
}

function canonicalRoot(value: string | Buffer): Buffer {
  if (Buffer.isBuffer(value)) {
    if (value.length !== 32) throw new ProductFeedbackRouteSubjectError();
    return value;
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) throw new ProductFeedbackRouteSubjectError();
  const root = Buffer.from(value, "base64url");
  if (root.length !== 32 || root.toString("base64url") !== value) {
    throw new ProductFeedbackRouteSubjectError();
  }
  return root;
}

export function deriveProductFeedbackRouteMaterial(rootValue: string | Buffer, coordinate: FeedbackRouteCoordinate) {
  const root = canonicalRoot(rootValue);
  const coordinateBytes = feedbackRouteTuple(
    "v1", coordinate.appId, coordinate.reporterIntegrationId, coordinate.reporterId,
  );
  const encKey = Buffer.from(hkdfSync(
    "sha256", root, SALT, feedbackRouteTuple("aes-256-gcm-key", coordinateBytes), 32,
  ));
  const nonceKey = Buffer.from(hkdfSync(
    "sha256", root, SALT, feedbackRouteTuple("nonce-hmac-key", coordinateBytes), 32,
  ));
  const aad = feedbackRouteTuple(
    "raft-feedback-route", "v1", coordinate.appId,
    coordinate.reporterIntegrationId, coordinate.reporterId,
  );
  return { coordinateBytes, encKey, nonceKey, aad };
}

export function mintProductFeedbackRouteSubject(input: {
  root: string | Buffer;
  userId: string;
  coordinate: FeedbackRouteCoordinate;
}): string {
  if (!UUID_RE.test(input.userId)) throw new ProductFeedbackRouteSubjectError();
  const { coordinateBytes, encKey, nonceKey, aad } = deriveProductFeedbackRouteMaterial(input.root, input.coordinate);
  const nonce = createHmac("sha256", nonceKey).update(feedbackRouteTuple(
    "raft-feedback-route-nonce", "v1", coordinateBytes, input.userId,
  )).digest().subarray(0, 12);
  const cipher = createCipheriv("aes-256-gcm", encKey, nonce);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(input.userId, "utf8"), cipher.final()]);
  const subject = `rfr_v1_${Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]).toString("base64url")}`;
  if (subject.length > 160) throw new ProductFeedbackRouteSubjectError();
  return subject;
}

export function decryptProductFeedbackRouteSubject(input: {
  root: string | Buffer;
  reporterIdSecret: string;
  subject: string;
  coordinate: FeedbackRouteCoordinate;
}): string {
  try {
    if (input.subject.length > 160 || !SUBJECT_RE.test(input.subject)) throw new Error();
    const encoded = input.subject.slice("rfr_v1_".length);
    const sealed = Buffer.from(encoded, "base64url");
    if (sealed.toString("base64url") !== encoded || sealed.length !== 12 + 36 + 16) throw new Error();
    const nonce = sealed.subarray(0, 12);
    const ciphertext = sealed.subarray(12, -16);
    const tag = sealed.subarray(-16);
    const { coordinateBytes, encKey, nonceKey, aad } = deriveProductFeedbackRouteMaterial(input.root, input.coordinate);
    const decipher = createDecipheriv("aes-256-gcm", encKey, nonce);
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    const userId = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    if (!UUID_RE.test(userId)) throw new Error();
    const expectedNonce = createHmac("sha256", nonceKey).update(feedbackRouteTuple(
      "raft-feedback-route-nonce", "v1", coordinateBytes, userId,
    )).digest().subarray(0, 12);
    if (!timingSafeEqual(nonce, expectedNonce)) throw new Error();
    const expectedReporter = Buffer.from(productFeedbackReporterId(userId, input.reporterIdSecret));
    const actualReporter = Buffer.from(input.coordinate.reporterId);
    if (expectedReporter.length !== actualReporter.length || !timingSafeEqual(expectedReporter, actualReporter)) throw new Error();
    return userId;
  } catch {
    throw new ProductFeedbackRouteSubjectError();
  }
}
