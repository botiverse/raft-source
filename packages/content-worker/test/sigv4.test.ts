import assert from "node:assert/strict";
import test from "node:test";

import { amzDate, EMPTY_SHA256, encodeSegment, signV4 } from "../src/services/r2Read";

/**
 * The Worker's Signature Version 4 signer (src/services/r2Read.ts) against
 * AWS's published examples: the signatures below are AWS's, not computed here.
 */

test("AWS's Signature Version 4 test suite, get-vanilla", async () => {
  const headers = await signV4(
    { method: "GET", url: new URL("https://example.amazonaws.com/") },
    { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" },
    { region: "us-east-1", service: "service" },
    new Date("2015-08-30T12:36:00Z"),
  );
  assert.deepEqual(headers, {
    "x-amz-date": "20150830T123600Z",
    authorization:
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
  });
});

test("Amazon S3's GET Object example (header-based authentication, a range)", async () => {
  const headers = await signV4(
    { method: "GET", url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"), headers: { Range: "bytes=0-9", "x-amz-content-sha256": EMPTY_SHA256 } },
    { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" },
    { region: "us-east-1", service: "s3" },
    new Date("2013-05-24T00:00:00Z"),
  );
  assert.equal(
    headers.authorization,
    "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
  );
  assert.equal(headers["x-amz-date"], "20130524T000000Z");
  assert.equal(headers.range, "bytes=0-9");
  assert.equal(headers.host, undefined, "host is signed, and sent by fetch from the URL");
});

test("the signature covers the host, the path and the time", async () => {
  const sign = (url: string, at = "2026-01-02T03:04:05Z") =>
    signV4({ method: "GET", url: new URL(url) }, { accessKeyId: "id", secretAccessKey: "secret" }, { region: "auto", service: "s3" }, new Date(at)).then(
      (headers) => headers.authorization,
    );
  const base = await sign("https://a.example/bucket/apps/artifacts/x");
  assert.notEqual(await sign("https://b.example/bucket/apps/artifacts/x"), base);
  assert.notEqual(await sign("https://a.example:8443/bucket/apps/artifacts/x"), base);
  assert.notEqual(await sign("https://a.example/bucket/apps/other/x"), base);
  assert.notEqual(await sign("https://a.example/bucket/apps/artifacts/x", "2026-01-02T03:04:06Z"), base);
  await assert.rejects(sign("https://a.example/bucket/x?list-type=2"), /without a query/);
});

test("time stamps and path segments as S3 wants them", () => {
  assert.equal(amzDate(new Date("2026-10-27T09:08:07.654Z")), "20261027T090807Z");
  assert.equal(encodeSegment("b_AZaz09-x"), "b_AZaz09-x");
  assert.equal(encodeSegment("a b+c/d~e!'()*"), "a%20b%2Bc%2Fd~e%21%27%28%29%2A");
});
