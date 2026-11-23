// The v1 checks. Local only: no command here talks to a network service or
// refreshes a token (`gh auth status`, `npm whoami`, `vercel whoami` are out
// on purpose). Each lists every argv it runs and every file and key it reads.
import {
  awsProfileSectionShape,
  awsRegionShape,
  displayNameShape,
  gcloudConfigNameShape,
  githubLoginShape,
  hostnameShape,
  maskedEmailShape,
  presenceShape,
  registryUrlShape,
  versionShape,
} from "./shapes";
import type { CheckContext, CheckItem, ComputerCheck, DeclaredFile, ReadKeysResult } from "./types";

/** A version row from `argv`; any output that is not a version is dropped. */
async function versionItem(ctx: CheckContext, key: string, label: string, argv: readonly string[]): Promise<CheckItem> {
  const result = await ctx.exec(argv);
  if ("unavailable" in result) {
    return result.unavailable === "not_installed"
      ? { key, label, status: "not_installed" }
      : { key, label, status: "unconfirmed", reason: result.unavailable };
  }
  const value = result.exitCode === 0 ? versionShape(result.stdout) : undefined;
  return value ? { key, label, value, status: "ok" } : { key, label, status: "unconfirmed", reason: "failed" };
}

/** The row for a declared file that exists but could not be used, else null. */
function fileProblem(result: ReadKeysResult, key: string, label: string): CheckItem | null {
  if (!("unavailable" in result) || result.unavailable === "missing") return null;
  return { key, label, status: "unconfirmed", reason: result.unavailable };
}

function sectionsOf(result: ReadKeysResult) {
  return "sections" in result ? result.sections : [];
}

const GH_VERSION = ["gh", "--version"] as const;
const GIT_USER_NAME = ["git", "config", "--global", "user.name"] as const;
const GIT_USER_EMAIL = ["git", "config", "--global", "user.email"] as const;
const GH_HOSTS: DeclaredFile = {
  path: ".config/gh/hosts.yml",
  format: "yaml",
  sectionShape: hostnameShape,
  keys: [{ key: "user", shape: githubLoginShape }],
};

async function gitIdentityItem(ctx: CheckContext, argv: readonly string[], key: string, label: string, shape: (raw: string) => string | undefined, displayText = false): Promise<CheckItem | null> {
  const result = await ctx.exec(argv);
  if ("unavailable" in result) {
    // A missing git is reported once, by the name row.
    return result.unavailable === "not_installed" ? null : { key, label, status: "unconfirmed", reason: result.unavailable };
  }
  // `git config` exits 1 when the key is unset.
  if (result.exitCode !== 0) return null;
  const value = shape(result.stdout.trim());
  if (!value) return null;
  return { key, label, value, ...(displayText ? { displayText: true as const } : {}), status: "local" };
}

const github: ComputerCheck = {
  id: "github",
  commands: [GH_VERSION, GIT_USER_NAME, GIT_USER_EMAIL],
  files: [GH_HOSTS],
  async run(ctx) {
    const [version, hosts, name, email] = await Promise.all([
      versionItem(ctx, "gh.version", "GitHub CLI", GH_VERSION),
      ctx.readKeys(GH_HOSTS),
      gitIdentityItem(ctx, GIT_USER_NAME, "git.user.name", "Git commit name", displayNameShape, true),
      gitIdentityItem(ctx, GIT_USER_EMAIL, "git.user.email", "Git commit email", maskedEmailShape),
    ]);
    const items: CheckItem[] = [version];
    const problem = fileProblem(hosts, "github.accounts", "GitHub accounts");
    if (problem) items.push(problem);
    for (const section of sectionsOf(hosts)) {
      const user = section.values.user;
      if (user) items.push({ key: `github.account:${section.name}`, label: `GitHub account (${section.name})`, value: user, status: "local" });
    }
    if (name) items.push(name);
    if (email) items.push(email);
    return items;
  },
};

const NODE_VERSION = ["node", "--version"] as const;
const PNPM_VERSION = ["pnpm", "--version"] as const;
const NPM_VERSION = ["npm", "--version"] as const;

const node: ComputerCheck = {
  id: "node",
  commands: [NODE_VERSION, PNPM_VERSION, NPM_VERSION],
  files: [],
  run: (ctx) => Promise.all([
    versionItem(ctx, "node.version", "Node.js", NODE_VERSION),
    versionItem(ctx, "pnpm.version", "pnpm", PNPM_VERSION),
    versionItem(ctx, "npm.version", "npm", NPM_VERSION),
  ]),
};

// Client only: `docker --version` never contacts the Docker daemon (`docker
// version` does, even with --format).
const DOCKER_VERSION = ["docker", "--version"] as const;

const docker: ComputerCheck = {
  id: "docker",
  commands: [DOCKER_VERSION],
  files: [],
  run: async (ctx) => [await versionItem(ctx, "docker.version", "Docker", DOCKER_VERSION)],
};

const GCLOUD_ACTIVE_CONFIG: DeclaredFile = {
  path: ".config/gcloud/active_config",
  format: "line",
  keys: [{ key: "value", shape: gcloudConfigNameShape }],
};
const GCLOUD_CONFIG: DeclaredFile = {
  path: ".config/gcloud/configurations/config_{param}",
  format: "ini",
  paramShape: gcloudConfigNameShape,
  sectionShape: (raw) => (raw === "core" ? raw : undefined),
  keys: [{ key: "account", shape: maskedEmailShape }],
};

const gcloud: ComputerCheck = {
  id: "gcloud",
  commands: [],
  files: [GCLOUD_ACTIVE_CONFIG, GCLOUD_CONFIG],
  async run(ctx) {
    const active = await ctx.readKeys(GCLOUD_ACTIVE_CONFIG);
    const activeProblem = fileProblem(active, "gcloud.config", "gcloud configuration");
    if (activeProblem) return [activeProblem];
    // gcloud uses `default` when no configuration was ever activated.
    const name = "sections" in active ? sectionsOf(active)[0]?.values.value : "default";
    if (!name) return [{ key: "gcloud.config", label: "gcloud configuration", status: "unconfirmed", reason: "parse_failed" }];
    const config = await ctx.readKeys(GCLOUD_CONFIG, name);
    if ("unavailable" in config && config.unavailable === "missing") return [];
    const items: CheckItem[] = [{ key: "gcloud.config", label: "gcloud configuration", value: name, status: "local" }];
    const problem = fileProblem(config, "gcloud.account", "gcloud account");
    if (problem) items.push(problem);
    const account = sectionsOf(config).find((s) => s.name === "core")?.values.account;
    if (account) items.push({ key: "gcloud.account", label: "gcloud account", value: account, status: "local" });
    return items;
  },
};

// Never ~/.aws/credentials: it holds the keys themselves.
const AWS_CONFIG: DeclaredFile = {
  path: ".aws/config",
  format: "ini",
  sectionShape: awsProfileSectionShape,
  keys: [{ key: "region", shape: awsRegionShape }],
};

const aws: ComputerCheck = {
  id: "aws",
  commands: [],
  files: [AWS_CONFIG],
  async run(ctx) {
    const config = await ctx.readKeys(AWS_CONFIG);
    const problem = fileProblem(config, "aws.profiles", "AWS profiles");
    if (problem) return [problem];
    return sectionsOf(config)
      .filter((s) => s.name !== "")
      .map((s) => ({ key: `aws.profile:${s.name}`, label: `AWS profile (${s.name})`, ...(s.values.region ? { value: s.values.region } : {}), status: "local" as const }));
  },
};

// `_authToken` (any `//host/:_authToken`) is read for presence only: the
// presence shape never keeps the value.
const NPMRC: DeclaredFile = {
  path: ".npmrc",
  format: "ini",
  keys: [
    { key: "registry", shape: registryUrlShape },
    { key: "_authToken", match: "suffix", shape: presenceShape },
  ],
};

const npm: ComputerCheck = {
  id: "npm",
  commands: [],
  files: [NPMRC],
  async run(ctx) {
    const npmrc = await ctx.readKeys(NPMRC);
    const problem = fileProblem(npmrc, "npm.config", "npm config");
    if (problem) return [problem];
    const top = sectionsOf(npmrc).find((s) => s.name === "")?.values ?? {};
    const items: CheckItem[] = [];
    if (top.registry) items.push({ key: "npm.registry", label: "npm registry", value: top.registry, status: "local" });
    items.push({ key: "npm.auth", label: "npm sign-in", value: top._authToken ? "token saved" : "no token saved", status: "local" });
    return items;
  },
};

const STAMP_VERSION = ["stamp", "--version"] as const;

const stamp: ComputerCheck = {
  id: "stamp",
  commands: [STAMP_VERSION],
  files: [],
  run: async (ctx) => [await versionItem(ctx, "stamp.version", "Stamp CLI", STAMP_VERSION)],
};

// `vercel whoami` refreshes the token in newer releases: version only.
const VERCEL_VERSION = ["vercel", "--version"] as const;

const vercel: ComputerCheck = {
  id: "vercel",
  commands: [VERCEL_VERSION],
  files: [],
  run: async (ctx) => [await versionItem(ctx, "vercel.version", "Vercel CLI", VERCEL_VERSION)],
};

export const COMPUTER_CHECKS: readonly ComputerCheck[] = [github, node, docker, gcloud, aws, npm, stamp, vercel];
