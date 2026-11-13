// When the process holding a pid started, as the OS reports it: the commands,
// their output formats, and the rule that tells a reused pid. Shared so the
// daemon (drivers/processTree.ts, the machine lock) and the Computer's
// commands, which run without daemon code, read and judge the same way. Pure:
// each caller runs the command itself.

/**
 * How much later than a record a process wrote about itself the process now
 * holding its pid may have started and still be that process. The process
 * writes the record after it starts, so it always started at or before it;
 * the slack only absorbs how the start is measured (Linux derives it from the
 * boot time, `ps lstart` has whole seconds) and small clock adjustments.
 */
export const PID_REUSE_TOLERANCE_MS = 5_000;

/**
 * Whether the process now holding a pid started after the record its earlier
 * holder wrote about itself (`recordedAtMs`): the pid was reused, and this is
 * another program. A start or a record time that could not be read is not
 * reuse: never act on uncertainty.
 */
export function startedAfterRecord(recordedAtMs: number, startedAtMs: number | undefined): boolean {
  return startedAtMs !== undefined && startedAtMs > recordedAtMs + PID_REUSE_TOLERANCE_MS;
}

const PS_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `ps lstart` in the C locale ("Thu Nov  5 19:53:52 2026", local time) as epoch ms. */
export function parsePsLstartMs(text: string): number | undefined {
  const match = /^[A-Za-z]{3}\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})\s+(\d{4})$/.exec(text.trim());
  if (!match) return undefined;
  const month = PS_MONTHS.indexOf(match[1]!);
  if (month < 0) return undefined;
  const ms = new Date(Number(match[6]), month, Number(match[2]), Number(match[3]), Number(match[4]), Number(match[5])).getTime();
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * Windows: the process's CreationDate from CIM (Win32_Process), as
 * `powershell.exe` arguments. Unlike `Get-Process` StartTime, which Windows
 * PowerShell 5.1 refuses ("Access is denied") for elevated, SYSTEM and
 * protected processes, CIM reports it for every process. `Get-CimInstance`
 * hands CreationDate over as a DateTime, printed here as a UTC round-trip
 * time; were it ever the raw DMTF string (`Get-WmiObject` style) it is printed
 * as is and parsed below. No process with that id prints nothing. `pid` is a
 * validated integer: never text.
 */
export function windowsCreationDateCommand(pid: number): string[] {
  return [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `$d = (Get-CimInstance -ClassName Win32_Process -Filter "ProcessId=${pid}" -ErrorAction Stop).CreationDate; ` +
      `if ($d -is [datetime]) { $d.ToUniversalTime().ToString('o') } elseif ($d) { [string]$d }`,
  ];
}

/**
 * A Windows creation time as UTC epoch microseconds: either the round-trip
 * UTC form (`2026-11-11T09:00:00.1234567Z`, digits past the microsecond
 * dropped) or CIM's DMTF form `yyyymmddHHMMSS.ffffff+UUU`, local time with
 * its offset from UTC in signed minutes. Undefined for anything else.
 */
export function parseWindowsCreationTimeUtcMicros(text: string): number | undefined {
  const trimmed = text.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?Z$/.exec(trimmed);
  if (iso) {
    const [, y, mo, d, h, mi, s, fraction = ""] = iso;
    const seconds = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
    return microsOrUndefined(seconds, fraction);
  }
  const dmtf = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(\d{6})([+-])(\d{3})$/.exec(trimmed);
  if (dmtf) {
    const [, y, mo, d, h, mi, s, fraction, sign, offset] = dmtf;
    const localAsUtc = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
    const offsetMinutes = (sign === "-" ? -1 : 1) * Number(offset);
    return microsOrUndefined(localAsUtc - offsetMinutes * 60_000, fraction!);
  }
  return undefined;
}

function microsOrUndefined(secondsMs: number, fraction: string): number | undefined {
  if (!Number.isFinite(secondsMs)) return undefined;
  const micros = secondsMs * 1000 + Number(fraction.slice(0, 6).padEnd(6, "0"));
  return Number.isSafeInteger(micros) ? micros : undefined;
}
