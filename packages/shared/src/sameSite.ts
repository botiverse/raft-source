// Whether two hostnames may be the same site, as Porthole decides it.
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/u;

/**
 * Whether two hostnames may be the same site: Porthole's own rule
 * (`maybeSameSite` in @botiverse/porthole 0.12 `dist/isolation/served.js`,
 * which the web's frame check applies before it mounts a frame), copied
 * because the package doesn't export it; sameSite.test.ts checks the two
 * agree. Equal, or sharing the last two labels, is the same site; an IP is a
 * site of its own; `localhost`'s subdomains are each one. Without the public
 * suffix list it errs one way only: a multi-label suffix (`a.co.uk`,
 * `b.co.uk`) counts as the same site, which refuses more, never less.
 */
export function maybeSameSite(hostA: string, hostB: string): boolean {
  const a = hostA.toLowerCase().replace(/\.$/u, "");
  const b = hostB.toLowerCase().replace(/\.$/u, "");
  if (a === b) return true;
  if (IPV4.test(a) || IPV4.test(b) || a.startsWith("[") || b.startsWith("[")) return false;
  const labelsA = a.split(".").reverse();
  const labelsB = b.split(".").reverse();
  let shared = 0;
  while (shared < labelsA.length && shared < labelsB.length && labelsA[shared] === labelsB[shared]) shared += 1;
  return shared >= 2;
}
