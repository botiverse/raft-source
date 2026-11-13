// API writes (any non-GET request) sent and not yet answered (api/client.ts
// counts them): a reload now would drop them on the floor, so the tab does not
// reload itself onto a new Web release meanwhile (utils/reloadSafety).
let inFlight = 0;
const counted = new WeakSet<object>();

/** api/client.ts, request sent: a write counts until it is answered. */
export function noteWriteSent(config: object, method: string | undefined): void {
  if ((method ?? "get").toLowerCase() === "get" || counted.has(config)) return;
  counted.add(config);
  inFlight += 1;
}

/** api/client.ts, answered or failed (a retry is sent, and counted, again). */
export function noteWriteSettled(config: object | undefined): void {
  if (!config || !counted.has(config)) return;
  counted.delete(config);
  inFlight -= 1;
}

export function hasWritesInFlight(): boolean {
  return inFlight > 0;
}
