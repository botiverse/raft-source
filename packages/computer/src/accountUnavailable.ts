import os from "node:os";
import path from "node:path";

import { matchDisplayLocale } from "@botiverse/raft-shared/src/displayLocales";
import type { DisplayLocale } from "@botiverse/raft-shared/src/displayLocales";
import type { UserSessionIdentity } from "./lib/userSession";
import { resolveDefaultRaftHome } from "./paths";

/** One message per display locale (the shared registry). */
export type AccountUnavailableLocale = DisplayLocale;

type CopyKey = "serverUnavailable";

export const ACCOUNT_UNAVAILABLE_MESSAGES: Record<AccountUnavailableLocale, Record<CopyKey, string>> = {
  en: {
    serverUnavailable:
      "Server {server} is not available to the account signed into Computer profile {profile} ({account}). " +
      "Without an account-bound setup link, Raft cannot tell whether the server is missing or is available to a different account. " +
      "Keep this profile and its runners running. To use another account in a separate profile, run {profileCommand}. " +
      "Or open {webUrl} with the account that should have access and verify its server membership.",
  },
  es: {
    serverUnavailable:
      "El servidor {server} no está disponible para la cuenta que inició sesión en el perfil de computadora {profile} ({account}). " +
      "Sin un enlace de configuración vinculado a una cuenta, Raft no puede saber si el servidor no existe o si está disponible para otra cuenta. " +
      "Mantén este perfil y sus runners en ejecución. Para usar otra cuenta en un perfil aparte, ejecuta {profileCommand}. " +
      "O abre {webUrl} con la cuenta que debería tener acceso y comprueba que sea miembro del servidor.",
  },
  "pt-br": {
    serverUnavailable:
      "O servidor {server} não está disponível para a conta conectada ao perfil de computador {profile} ({account}). " +
      "Sem um link de configuração vinculado a uma conta, o Raft não consegue saber se o servidor não existe ou se está disponível para outra conta. " +
      "Mantenha este perfil e os runners dele em execução. Para usar outra conta em um perfil separado, execute {profileCommand}. " +
      "Ou abra {webUrl} com a conta que deveria ter acesso e confirme se ela é membro do servidor.",
  },
  ru: {
    serverUnavailable:
      "Сервер {server} недоступен для аккаунта ({account}), под которым выполнен вход в профиль компьютера {profile}. " +
      "Без ссылки для настройки, привязанной к аккаунту, Raft не может определить, отсутствует ли сервер или он доступен другому аккаунту. " +
      "Не останавливайте этот профиль и его раннеры. Чтобы использовать другой аккаунт в отдельном профиле, выполните {profileCommand}. " +
      "Или откройте {webUrl} под аккаунтом, у которого должен быть доступ, и убедитесь, что этот аккаунт — участник сервера.",
  },
  "zh-cn": {
    serverUnavailable:
      "当前 Computer 配置档 {profile} 登录的账号（{account}）无法访问服务器 {server}。" +
      "没有绑定账号的 setup 链接时，Raft 无法判断该服务器不存在，还是可由其他账号访问。" +
      "请保持当前配置档及其运行程序继续运行。若要使用另一个账号，请在独立配置档中运行 {profileCommand}。" +
      "或者使用应当有权限的账号打开 {webUrl}，确认该账号的服务器成员身份。",
  },
  "zh-tw": {
    serverUnavailable:
      "電腦設定檔 {profile} 登入的帳號（{account}）無法存取伺服器 {server}。" +
      "沒有綁定帳號的設定連結時，Raft 無法判斷這個伺服器不存在，還是可以由其他帳號存取。" +
      "請讓這個設定檔和它的 runner 繼續執行。若要在另一個設定檔中使用其他帳號，請執行 {profileCommand}。" +
      "或使用應該有權限的帳號開啟 {webUrl}，確認該帳號是否為伺服器成員。",
  },
  ja: {
    serverUnavailable:
      "コンピューターのプロファイル {profile} にログインしているアカウント（{account}）は、サーバー {server} を利用できません。" +
      "アカウントに紐付いたセットアップリンクがないため、Raft はこのサーバーが存在しないのか、別のアカウントなら利用できるのかを判別できません。" +
      "このプロファイルとそのランナーは実行したままにしてください。別のアカウントを別のプロファイルで使うには、{profileCommand} を実行してください。" +
      "または、アクセス権を持つはずのアカウントで {webUrl} を開き、そのアカウントがサーバーのメンバーかどうかを確認してください。",
  },
  ko: {
    serverUnavailable:
      "컴퓨터 프로필 {profile}에 로그인한 계정({account})은 서버 {server}에 접근할 수 없어요. " +
      "계정에 연결된 설정 링크가 없으면 Raft는 서버가 없는 것인지, 다른 계정으로는 접근할 수 있는 것인지 알 수 없어요. " +
      "이 프로필과 러너는 계속 실행해 두세요. 다른 계정을 별도 프로필에서 사용하려면 {profileCommand} 명령을 실행하세요. " +
      "또는 접근 권한이 있어야 하는 계정으로 {webUrl} 페이지를 열어 그 계정이 서버 멤버인지 확인하세요.",
  },
};

const ACCOUNT_UNAVAILABLE_LABELS: Record<AccountUnavailableLocale, { user: string; currentAccount: string; customStateHome: string }> = {
  en: { user: "user", currentAccount: "current account", customStateHome: "custom state home" },
  es: { user: "usuario", currentAccount: "cuenta actual", customStateHome: "directorio de estado personalizado" },
  "pt-br": { user: "usuário", currentAccount: "conta atual", customStateHome: "diretório de estado personalizado" },
  ru: { user: "пользователь", currentAccount: "текущий аккаунт", customStateHome: "пользовательский каталог состояния" },
  "zh-cn": { user: "用户", currentAccount: "当前账号", customStateHome: "自定义状态目录" },
  ja: { user: "ユーザー", currentAccount: "現在のアカウント", customStateHome: "カスタムの状態ディレクトリ" },
  ko: { user: "사용자", currentAccount: "현재 계정", customStateHome: "사용자 지정 상태 디렉터리" },
  "zh-tw": { user: "使用者", currentAccount: "目前帳號", customStateHome: "自訂狀態目錄" },
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
  // POSIX locale (`ja_JP.UTF-8`, `zh_TW@…`) → BCP 47 (`ja-JP`) for the shared matcher.
  const requested = (env.LC_ALL || env.LC_MESSAGES || env.LANG || "").trim().split(/[.@]/)[0].replace(/_/g, "-");
  return matchDisplayLocale(requested) ?? "en";
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
    const prefix = ACCOUNT_UNAVAILABLE_LABELS[locale].user;
    return userId.length > 12 ? `${prefix} ${userId.slice(0, 8)}…` : `${prefix} ${userId}`;
  }
  return ACCOUNT_UNAVAILABLE_LABELS[locale].currentAccount;
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
  const defaultHome = resolveDefaultRaftHome(homeDir);
  if (resolved === defaultHome) return "default";

  const profilesRoot = path.join(defaultHome, "profiles");
  const relative = path.relative(profilesRoot, resolved);
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative) && !relative.includes(path.sep)) {
    return JSON.stringify(relative);
  }
  return ACCOUNT_UNAVAILABLE_LABELS[locale].customStateHome;
}

function alternateProfileHome(slockHome: string, homeDir: string): string {
  const resolved = path.resolve(slockHome);
  const defaultHome = resolveDefaultRaftHome(homeDir);
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
    // setup signs in (or asks for approval) itself; `login` no longer
    // writes a user session on current servers.
    return `${assignment}; raft-computer setup ${quotePowerShellLiteral(serverLabel)}`;
  }
  const assignment = `SLOCK_HOME=${posixPathExpression(profileHome, homeDir)}`;
  return `${assignment} raft-computer setup ${quotePosix(serverLabel)}`;
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
