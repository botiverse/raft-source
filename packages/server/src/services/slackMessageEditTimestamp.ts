/** Slack timestamps retain microsecond precision; never compare them as JS Dates. */
export function parseSlackEditTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || !/^[0-9]{1,20}\.[0-9]{1,6}$/.test(value)) return null;
  const [seconds, micros] = value.split(".");
  return `${BigInt(seconds!)}.${micros!.padEnd(6, "0")}`;
}

export function slackEditTimestampIsNewer(next: string, previous: string): boolean {
  const key = (value: string) => {
    const [seconds, micros] = value.split(".");
    return BigInt(seconds!) * 1_000_000n + BigInt(micros!.padEnd(6, "0"));
  };
  return key(next) > key(previous);
}
