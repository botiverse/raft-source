// Is a raw 32-byte Ed25519 public key one a configuration may name? node:crypto
// imports any 32 bytes as an Ed25519 key, so a mistyped or placeholder key
// would only show up as every signature failing, and an all-zero placeholder
// is a small-order point (under which a verifier that does not refuse it
// accepts forged signatures; OpenSSL 3.5 refuses them, older ones may not).
// This decodes the point as RFC 8032 §5.1.3 does and refuses, with what is
// wrong: a length other than 32, a y that is not reduced (y >= p), a point
// not on the curve, x = 0 with the sign bit set, and the 8 small-order points
// ([8]A is the identity). It checks a configured key, never a signature:
// verifying stays node:crypto's.

const P = 2n ** 255n - 19n;
const mod = (a: bigint): bigint => ((a % P) + P) % P;

function pow(base: bigint, exponent: bigint): bigint {
  let result = 1n;
  let b = mod(base);
  let e = exponent;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % P;
    b = (b * b) % P;
    e >>= 1n;
  }
  return result;
}

const inverse = (a: bigint): bigint => pow(a, P - 2n);
const D = mod(-121665n * inverse(121666n));
const SQRT_MINUS_ONE = pow(2n, (P - 1n) / 4n);

/** What is wrong with `raw` as an Ed25519 public key, or null when it is a valid point of more than small order. */
export function ed25519PublicKeyProblem(raw: Uint8Array): string | null {
  if (raw.length !== 32) return `${raw.length} bytes, not 32`;
  const bytes = Uint8Array.from(raw);
  const xIsOdd = (bytes[31]! & 0x80) !== 0;
  bytes[31]! &= 0x7f;
  const y = BigInt(`0x${Buffer.from(bytes).reverse().toString("hex")}`);
  if (y >= P) return "not a canonical point encoding";
  // x² = (y² - 1) / (d y² + 1), its root as RFC 8032 §5.1.3 takes it.
  const y2 = (y * y) % P;
  const u = mod(y2 - 1n);
  const v = mod(D * y2 + 1n);
  let x = mod(u * pow(v, 3n) * pow(u * pow(v, 7n), (P - 5n) / 8n));
  const vx2 = mod(v * x * x);
  if (vx2 === mod(-u)) x = mod(x * SQRT_MINUS_ONE);
  else if (vx2 !== u) return "not a point on the curve";
  if (x === 0n && xIsOdd) return "not a canonical point encoding";
  // Three doublings (-x² + y² = 1 + d x² y², so the denominators are never 0).
  let px = x;
  let py = y;
  for (let i = 0; i < 3; i++) {
    const xx = (px * px) % P;
    const yy = (py * py) % P;
    [px, py] = [mod(2n * px * py * inverse(yy - xx)), mod((yy + xx) * inverse(2n - yy + xx))];
  }
  if (px === 0n && py === 1n) return "a small-order point";
  return null;
}
