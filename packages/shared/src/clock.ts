export function currentTimeMs(): number {
  return Date.now();
}

export function currentDate(): Date {
  return new Date(currentTimeMs());
}

export function currentRandomUnit(): number {
  return Math.random();
}

export function setClockInterval(fn: () => void, ms: number): unknown {
  return setInterval(fn, ms);
}

export function clearClockInterval(interval: unknown): void {
  clearInterval(interval as ReturnType<typeof setInterval>);
}

export function setClockTimeout(fn: () => void, ms: number): unknown {
  return setTimeout(fn, ms);
}

export function clearClockTimeout(timeout: unknown): void {
  clearTimeout(timeout as ReturnType<typeof setTimeout>);
}
