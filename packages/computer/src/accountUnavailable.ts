import os from "node:os";
import path from "node:path";

import type { UserSessionIdentity } from "./lib/userSession.js";

export type AccountUnavailableLocale = "en" | "zh-cn";

type CopyKey = "serverUnavailable";

export const ACCOUNT_UNAVAILABLE_MESSAGES: Record<AccountUnavailableLocale, Record<CopyKey, string>> = {
  en: {
    serverUnavailable:
      "Server {server} is not available to the account signed into Computer profile {profile} ({account}). " +
      "Without an account-bound setup link, Raft cannot tell whether the server is missing or is available to a different account. " +
      "Keep this profile and its runners running. To use another account in a separate profile, run {profileCommand}. " +
      "Or open {webUrl} with the account that should have access and verify its server membership.",
  },
  "zh-cn": {
    serverUnavailable:
      "当前 Computer 配置档 {profile} 登录的账号（{account}）无法访问服务器 {server}。" +
      "没有绑定账号的 setup 链接时，Raft 无法判断该服务器不存在，还是可由其他账号访问。" +
      "请保持当前配置档及其运行程序继续运行。若要使用另一个账号，请在独立配置档中运行 {profileCommand}。" +
      "或者使用应当有权限的账号打开 {webUrl}，确认该账号的服务器成员身份。",
  },
};

export interface AccountUnavailableMessageInput {
  serverLabel: string;
  serverSlug: string;
  slockHome: string;
  identity: UserSessionIdentity | null;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  platform?: NodeJS.Platform;
}

export function resolveAccountUnavailableLocale(
  env: NodeJS.ProcessEnv = process.env,
): AccountUnavailableLocale {
  const requested = env.LC_ALL || env.LC_MESSAGES || env.LANG || "";
  return /^zh(?:[_-]|$)/i.test(requested.trim()) ? "zh-cn" : "en";
}

export function accountUnavailableMessage(
  input: AccountUnavailableMessageInput,
): string {
  const env = input.env ?? process.env;
  const homeDir = input.homeDir ?? os.homedir();
  const platform = input.platform ?? process.platform;
  const locale = resolveAccountUnavailableLocale(env);
  const profile = profileLabel(input.slockHome, homeDir, locale);
  const alternateHome = alternateProfileHome(input.slockHome, homeDir);
  const profileCommand = markdownCodeSpan(
    profileRecoveryCommand(alternateHome, input.serverLabel, platform, homeDir),
  );
  const webUrl = `https://app.raft.build/s/${encodeURIComponent(input.serverSlug)}/`;

  return interpolate(ACCOUNT_UNAVAILABLE_MESSAGES[locale].serverUnavailable, {
    server: input.serverLabel,
    profile,
    account: boundedAccountLabel(input.identity, locale),
    profileCommand,
    webUrl,
  });
}

function boundedAccountLabel(
  identity: UserSessionIdentity | null,
  locale: AccountUnavailableLocale,
): string {
  const name = boundedText(identity?.name);
  if (name) return name.startsWith("@") ? name : `@${name}`;
  const displayName = boundedText(identity?.displayName);
  if (displayName) return displayName;
  const userId = boundedText(identity?.userId);
  if (userId) {
    const prefix = locale === "zh-cn" ? "用户" : "user";
    return userId.length > 12 ? `${prefix} ${userId.slice(0, 8)}…` : `${prefix} ${userId}`;
  }
  return locale === "zh-cn" ? "当前账号" : "current account";
}

function boundedText(value: string | undefined): string | null {
  if (typeof value !== "string") return null;
  const clean = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!clean) return null;
  return clean.length > 64 ? `${clean.slice(0, 63)}…` : clean;
}

function profileLabel(
  slockHome: string,
  homeDir: string,
  locale: AccountUnavailableLocale,
): string {
  const resolved = path.resolve(slockHome);
  const defaultHome = path.resolve(homeDir, ".slock");
  if (resolved === defaultHome) return "default";

  const profilesRoot = path.join(defaultHome, "profiles");
  const relative = path.relative(profilesRoot, resolved);
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative) && !relative.includes(path.sep)) {
    return JSON.stringify(relative);
  }
  return locale === "zh-cn" ? "自定义状态目录" : "custom state home";
}

function alternateProfileHome(slockHome: string, homeDir: string): string {
  const resolved = path.resolve(slockHome);
  const defaultHome = path.resolve(homeDir, ".slock");
  const profilesRoot = path.join(defaultHome, "profiles");
  const relative = path.relative(profilesRoot, resolved);
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative) && !relative.includes(path.sep)) {
    return path.join(profilesRoot, "<other-profile>");
  }
  if (resolved === defaultHome) return path.join(defaultHome, "profiles", "<other-profile>");
  return path.join(resolved, "profiles", "<other-profile>");
}

function profileRecoveryCommand(
  profileHome: string,
  serverLabel: string,
  platform: NodeJS.Platform,
  homeDir: string,
): string {
  if (platform === "win32") {
    const assignment = `$env:SLOCK_HOME = ${powerShellPathExpression(profileHome, homeDir)}`;
    return `${assignment}; raft-computer login; if ($?) { raft-computer setup ${quotePowerShellLiteral(serverLabel)} }`;
  }
  const assignment = `SLOCK_HOME=${posixPathExpression(profileHome, homeDir)}`;
  return `${assignment} raft-computer login && ${assignment} raft-computer setup ${quotePosix(serverLabel)}`;
}

function relativeHomePath(target: string, homeDir: string): string | null {
  const resolved = path.resolve(target);
  const home = path.resolve(homeDir);
  const relative = path.relative(home, resolved);
  return !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : null;
}

function posixPathExpression(target: string, homeDir: string): string {
  const relative = relativeHomePath(target, homeDir);
  if (relative === null) return quotePosix(path.resolve(target));
  if (!relative) return '"$HOME"';
  return `"$HOME"/${quotePosix(relative.split(path.sep).join("/"))}`;
}

function powerShellPathExpression(target: string, homeDir: string): string {
  const relative = relativeHomePath(target, homeDir);
  if (relative === null) return quotePowerShellLiteral(path.resolve(target));
  if (!relative) return "$HOME";
  return `$HOME + ${quotePowerShellLiteral(`\\${relative.split(path.sep).join("\\")}`)}`;
}

function quotePosix(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function quotePowerShellLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function markdownCodeSpan(value: string): string {
  const widestRun = Math.max(0, ...[...value.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = "`".repeat(widestRun + 1);
  const padding = value.startsWith("`") || value.endsWith("`") ? " " : "";
  return `${fence}${padding}${value}${padding}${fence}`;
}

function interpolate(template: string, values: Record<string, string>): string {
  return template.replace(/\{([a-zA-Z]+)\}/g, (_match, key: string) => values[key] ?? `{${key}}`);
}
