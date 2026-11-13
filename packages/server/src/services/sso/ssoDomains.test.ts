import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  checkSsoDomainRecord,
  isPublicEmailDomain,
  nextSsoDomainState,
  normalizeSsoDomain,
  SSO_DOMAIN_ABSENCE_CONFIRM_MS,
  SSO_DOMAIN_FAILURE_GRACE_MS,
  ssoDomainRecordName,
  ssoDomainRecordValue,
  type SsoDomainState,
  type TxtResolver,
} from "./ssoDomains";

const unverified: SsoDomainState = { verifiedAt: null, lastCheckedAt: null, lastCheckResult: null, absentSince: null, failingSince: null };
const t0 = new Date("2026-11-04T00:00:00Z");
const at = (ms: number) => new Date(t0.getTime() + ms);

function dnsError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

describe("normalizeSsoDomain", () => {
  test("accepts company domains, normalised", () => {
    assert.equal(normalizeSsoDomain("Acme.COM"), "acme.com");
    assert.equal(normalizeSsoDomain(" eu.acme.com. "), "eu.acme.com");
    assert.equal(normalizeSsoDomain("bücher.de"), "xn--bcher-kva.de");
  });

  test("refuses what is not a bare domain", () => {
    for (const raw of ["", "acme", "https://acme.com", "alice@acme.com", "*.acme.com", "acme.com/x", "10.0.0.1", "-acme.com", "ac me.com", 42, null]) {
      assert.equal(normalizeSsoDomain(raw), null, String(raw));
    }
  });

  test("knows public mailbox providers", () => {
    assert.equal(isPublicEmailDomain("gmail.com"), true);
    assert.equal(isPublicEmailDomain("qq.com"), true);
    assert.equal(isPublicEmailDomain("acme.com"), false);
  });
});

describe("checkSsoDomainRecord", () => {
  const token = "tok123";

  test("asks for the record under _raft-verification and finds it, even split into chunks", async () => {
    let asked = "";
    const resolve: TxtResolver = async (name) => {
      asked = name;
      return [["unrelated"], ["raft-domain-", "verification=tok123"]];
    };
    assert.equal(await checkSsoDomainRecord("acme.com", token, resolve), "present");
    assert.equal(asked, ssoDomainRecordName("acme.com"));
    assert.equal(ssoDomainRecordValue(token), "raft-domain-verification=tok123");
  });

  test("another token, NXDOMAIN and NODATA are confirmed absences", async () => {
    assert.equal(await checkSsoDomainRecord("acme.com", token, async () => [["raft-domain-verification=other"]]), "absent");
    assert.equal(await checkSsoDomainRecord("acme.com", token, async () => { throw dnsError("ENOTFOUND"); }), "absent");
    assert.equal(await checkSsoDomainRecord("acme.com", token, async () => { throw dnsError("ENODATA"); }), "absent");
  });

  test("timeouts and server failures are failed lookups", async () => {
    for (const code of ["ETIMEOUT", "ESERVFAIL", "ECONNREFUSED", undefined]) {
      const resolve: TxtResolver = async () => { throw code ? dnsError(code) : new Error("boom"); };
      assert.equal(await checkSsoDomainRecord("acme.com", token, resolve), "lookup_failed", String(code));
    }
  });
});

describe("nextSsoDomainState", () => {
  test("present verifies and ends both streaks", () => {
    const next = nextSsoDomainState({ ...unverified, absentSince: t0, failingSince: t0 }, "present", at(5));
    assert.deepEqual(next.verifiedAt, at(5));
    assert.equal(next.absentSince, null);
    assert.equal(next.failingSince, null);
    const again = nextSsoDomainState(next, "present", at(10));
    assert.deepEqual(again.verifiedAt, at(5), "keeps the first verification time");
  });

  test("an unverified domain that is absent stays unverified with no streak", () => {
    const next = nextSsoDomainState(unverified, "absent", t0);
    assert.equal(next.verifiedAt, null);
    assert.equal(next.absentSince, null);
  });

  test("a verified domain is unverified by a second absence at least an hour after the first", () => {
    const verified = nextSsoDomainState(unverified, "present", t0);
    const first = nextSsoDomainState(verified, "absent", at(1));
    assert.notEqual(first.verifiedAt, null, "one absence is not enough");
    assert.deepEqual(first.absentSince, at(1));
    const tooSoon = nextSsoDomainState(first, "absent", at(1 + SSO_DOMAIN_ABSENCE_CONFIRM_MS - 1));
    assert.notEqual(tooSoon.verifiedAt, null);
    const confirmed = nextSsoDomainState(tooSoon, "absent", at(1 + SSO_DOMAIN_ABSENCE_CONFIRM_MS));
    assert.equal(confirmed.verifiedAt, null);
    assert.equal(confirmed.absentSince, null);
  });

  test("a failed lookup between two absences neither confirms nor resets the streak", () => {
    const verified = nextSsoDomainState(unverified, "present", t0);
    const absent = nextSsoDomainState(verified, "absent", at(1));
    const failed = nextSsoDomainState(absent, "lookup_failed", at(2));
    assert.notEqual(failed.verifiedAt, null);
    assert.deepEqual(failed.absentSince, at(1));
    const confirmed = nextSsoDomainState(failed, "absent", at(1 + SSO_DOMAIN_ABSENCE_CONFIRM_MS));
    assert.equal(confirmed.verifiedAt, null);
  });

  test("failed lookups unverify only after the grace period, and a success ends the streak", () => {
    const verified = nextSsoDomainState(unverified, "present", t0);
    const failing = nextSsoDomainState(verified, "lookup_failed", at(1));
    const stillFailing = nextSsoDomainState(failing, "lookup_failed", at(SSO_DOMAIN_FAILURE_GRACE_MS));
    assert.notEqual(stillFailing.verifiedAt, null);
    assert.deepEqual(stillFailing.failingSince, at(1));
    const lapsed = nextSsoDomainState(stillFailing, "lookup_failed", at(1 + SSO_DOMAIN_FAILURE_GRACE_MS));
    assert.equal(lapsed.verifiedAt, null);
    const recovered = nextSsoDomainState(stillFailing, "present", at(2 * SSO_DOMAIN_FAILURE_GRACE_MS));
    assert.notEqual(recovered.verifiedAt, null);
    assert.equal(recovered.failingSince, null);
  });
});
