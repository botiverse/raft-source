import { CliError } from "../core/errors.js";

export interface TargetAliasOpts {
  target?: string;
  channel?: string;
}

export function resolveTargetAlias(opts: TargetAliasOpts): string | undefined {
  const target = opts.target?.trim();
  const legacyChannel = opts.channel?.trim();
  if (target && legacyChannel && target !== legacyChannel) {
    throw new CliError({
      code: "INVALID_ARG",
      message: "--target and legacy --channel must refer to the same target when both are provided",
    });
  }
  return target || legacyChannel || undefined;
}

export function requireTargetAlias(opts: TargetAliasOpts): string {
  const target = resolveTargetAlias(opts);
  if (!target) {
    throw new CliError({
      code: "INVALID_ARG",
      message: "--target is required (legacy --channel is accepted during the transition)",
    });
  }
  return target;
}
