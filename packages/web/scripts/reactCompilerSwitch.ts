// React Compiler, behind a build-time switch that is OFF unless the build's
// environment says RAFT_WEB_REACT_COMPILER=1. Only the staging web build sets it
// (.github/workflows/deploy-web-staging-s3.yml and first-screen-record.yml, which
// rebuilds the deployed commit). Off, this module adds no plugin and loads no
// Babel: the bundle is the one the build made before the switch existed.
//
// On, it is the setup react.dev documents for @vitejs/plugin-react 6:
// @rolldown/plugin-babel with plugin-react's reactCompilerPreset
// (babel-plugin-react-compiler). A component or hook the compiler cannot compile
// is left as written and the build goes on (panicThreshold "none", stated here
// so that a changed default cannot turn one such component into a failed
// deploy). The build prints how many it compiled and left, and the page says it
// was compiled: <html data-react-compiler="1">.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import type { Plugin, PluginOption } from "vite";

export const REACT_COMPILER_ENV = "RAFT_WEB_REACT_COMPILER";
/** Optional path of a JSON report of what was compiled and what was left. */
export const REACT_COMPILER_REPORT_ENV = "RAFT_WEB_REACT_COMPILER_REPORT";
export const REACT_COMPILER_HTML_ATTRIBUTE = "data-react-compiler";

type BuildEnvironment = Readonly<Record<string, string | undefined>>;

/**
 * "1" is on; unset, empty and "0" are off. Anything else stops the build, so a
 * staging build asked for the compiler with `true` does not quietly ship without it.
 */
export function reactCompilerEnabled(environment: BuildEnvironment): boolean {
  const value = environment[REACT_COMPILER_ENV]?.trim() ?? "";
  if (value === "1") return true;
  if (value === "" || value === "0") return false;
  throw new Error(`${REACT_COMPILER_ENV} must be 1 or 0 (got ${JSON.stringify(value)})`);
}

/** The part of the compiler's logger events the report reads. */
export type ReactCompilerEvent = Readonly<{
  kind: string;
  fnName?: string | null;
  fnLoc?: { start?: { line?: number } } | null;
  reason?: string;
  data?: string;
  detail?: unknown;
}>;

export type ReactCompilerLeft = Readonly<{ file: string; line: number | null; kind: string; reason: string }>;

export type ReactCompilerReport = Readonly<{
  compiled: number;
  left: number;
  filesCompiled: number;
  filesLeft: number;
  reasons: Readonly<Record<string, number>>;
  leftFunctions: readonly ReactCompilerLeft[];
}>;

function eventReason(event: ReactCompilerEvent): string {
  if (typeof event.reason === "string") return event.reason;
  if (typeof event.data === "string") return event.data.split("\n")[0];
  const detail = event.detail as { reason?: unknown; options?: { reason?: unknown } } | undefined;
  const reason = detail?.reason ?? detail?.options?.reason;
  return typeof reason === "string" ? reason : "unknown";
}

/** Counts the compiler's events: one "compiled" or one "left" per component or hook. */
export function createReactCompilerRecorder(root: string) {
  let compiled = 0;
  const compiledFiles = new Set<string>();
  // One entry per function: the compiler can report more than one error for it.
  const left = new Map<string, ReactCompilerLeft>();
  return {
    logEvent(filename: string | null, event: ReactCompilerEvent): void {
      const file = filename === null ? "unknown" : relative(root, filename);
      if (event.kind === "CompileSuccess") {
        compiled += 1;
        compiledFiles.add(file);
        return;
      }
      if (event.kind !== "CompileError" && event.kind !== "CompileSkip" && event.kind !== "PipelineError") return;
      const line = event.fnLoc?.start?.line ?? null;
      const key = `${file}:${line ?? "?"}`;
      if (!left.has(key)) left.set(key, { file, line, kind: event.kind, reason: eventReason(event) });
    },
    report(): ReactCompilerReport {
      const leftFunctions = [...left.values()].sort((a, b) => a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0));
      const reasons: Record<string, number> = {};
      for (const entry of leftFunctions) reasons[entry.reason] = (reasons[entry.reason] ?? 0) + 1;
      return {
        compiled,
        left: leftFunctions.length,
        filesCompiled: compiledFiles.size,
        filesLeft: new Set(leftFunctions.map((entry) => entry.file)).size,
        reasons: Object.fromEntries(Object.entries(reasons).sort((a, b) => b[1] - a[1])),
        leftFunctions,
      };
    },
  };
}

export type ReactCompilerRecorder = ReturnType<typeof createReactCompilerRecorder>;

/** The options babel-plugin-react-compiler runs with here. */
export function reactCompilerOptions(recorder: ReactCompilerRecorder) {
  return { panicThreshold: "none" as const, logger: { logEvent: recorder.logEvent } };
}

/** Marks the page as built with the compiler: `document.documentElement.dataset.reactCompiler === "1"`. */
export function markReactCompilerHtml(html: string): string {
  if (!/<html[\s>]/.test(html)) throw new Error("React Compiler marker: no <html> tag to mark");
  return html.replace(/<html(?=[\s>])/, `<html ${REACT_COMPILER_HTML_ATTRIBUTE}="1"`);
}

function reactCompilerReportPlugin(recorder: ReactCompilerRecorder, environment: BuildEnvironment, root: string): Plugin {
  return {
    name: "raft-react-compiler-report",
    apply: "build",
    transformIndexHtml: { order: "pre", handler: markReactCompilerHtml },
    async closeBundle() {
      const report = recorder.report();
      // The boot shell's render loads this config too and compiles nothing.
      if (report.compiled === 0 && report.left === 0) return;
      const top = Object.entries(report.reasons).slice(0, 3).map(([reason, count]) => `${count}x ${reason}`).join("; ");
      this.info(
        `React Compiler: compiled ${report.compiled} components and hooks in ${report.filesCompiled} files; ` +
          `left ${report.left} as written in ${report.filesLeft} files${top ? ` (${top})` : ""}`,
      );
      const reportPath = environment[REACT_COMPILER_REPORT_ENV]?.trim();
      if (!reportPath) return;
      const target = resolve(root, reportPath);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, `${JSON.stringify(report, null, 2)}\n`);
    },
  };
}

/**
 * The plugins that turn the compiler on, or none. `everyEnvironment` is for
 * Vitest, whose node environment is not the browser one the preset limits itself to.
 */
export async function reactCompilerPlugins(
  environment: BuildEnvironment,
  root: string,
  { everyEnvironment = false }: { everyEnvironment?: boolean } = {},
): Promise<PluginOption[]> {
  if (!reactCompilerEnabled(environment)) return [];
  // Loaded only when on: a build without the switch never touches Babel.
  const [{ default: babel }, { reactCompilerPreset }] = await Promise.all([
    import("@rolldown/plugin-babel"),
    import("@vitejs/plugin-react"),
  ]);
  const recorder = createReactCompilerRecorder(root);
  const preset = reactCompilerPreset(reactCompilerOptions(recorder));
  if (everyEnvironment) preset.rolldown.applyToEnvironmentHook = () => true;
  return [babel({ presets: [preset] }), reactCompilerReportPlugin(recorder, environment, root)];
}
