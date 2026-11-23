// Rows read back from the shared round file (`computer/checks-round.json`,
// service.ts). Anything running as the Computer's user can write that file,
// so a row from it is used only if it is a row the checks in plugins.ts could
// have produced: a known key with its label, a value of that key's shape
// (the same shape validators, in the form the check emits), a status the row
// can have, `displayText` only where the check sets it, each key once, and
// text the Computer's scrub leaves as is. Anything else and
// the whole file is not reused (a new round runs).
import { isCheckUnconfirmedReason } from "@botiverse/raft-shared";
import { scrubCheckText } from "./runner";
import {
  awsRegionShape,
  displayNameShape,
  gcloudConfigNameShape,
  githubLoginShape,
  hostnameShape,
  registryUrlShape,
  versionShape,
} from "./shapes";
import type { CheckItem, CheckItemStatus, ComputerCheckId, ComputerCheckPluginReport, ValueShape } from "./types";

/** A value the check emitted is a fixed point of its shape. */
const exactly = (shape: ValueShape) => (value: string) => shape(value) === value;

// maskRuntimeAccountEmail's output: 1 or 3 characters, ****, up to 5, @domain.
const MASKED_EMAIL = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,3}\*{4}[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{0,5}@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;
const isMaskedEmail = (value: string) => value.length <= 80 && MASKED_EMAIL.test(value);
// A display name holding an email is emitted masked (displayNameShape).
const isDisplayName = (value: string) => (value.includes("@") ? isMaskedEmail(value) : displayNameShape(value) === value);
const AWS_PROFILE = /^(?:default|[A-Za-z0-9_.-]{1,64})$/;

interface RowRule {
  label: string;
  /** Statuses with a value, and the value's form. */
  value?: { statuses: readonly CheckItemStatus[]; valid: (value: string) => boolean };
  /** Statuses without a value (`unconfirmed` always needs a reason). */
  bare: readonly CheckItemStatus[];
  displayText?: true;
}

const versionRow = (label: string): RowRule => ({ label, value: { statuses: ["ok"], valid: exactly(versionShape) }, bare: ["not_installed", "unconfirmed"] });
const problemRow = (label: string): RowRule => ({ label, bare: ["unconfirmed"] });

const FIXED_ROWS: Readonly<Record<ComputerCheckId, Readonly<Record<string, RowRule>>>> = {
  github: {
    "gh.version": versionRow("GitHub CLI"),
    "github.accounts": problemRow("GitHub accounts"),
    "git.user.name": { label: "Git commit name", value: { statuses: ["local"], valid: isDisplayName }, bare: ["unconfirmed"], displayText: true },
    "git.user.email": { label: "Git commit email", value: { statuses: ["local"], valid: isMaskedEmail }, bare: ["unconfirmed"] },
  },
  node: { "node.version": versionRow("Node.js"), "pnpm.version": versionRow("pnpm"), "npm.version": versionRow("npm") },
  docker: { "docker.version": versionRow("Docker") },
  gcloud: {
    "gcloud.config": { label: "gcloud configuration", value: { statuses: ["local"], valid: exactly(gcloudConfigNameShape) }, bare: ["unconfirmed"] },
    "gcloud.account": { label: "gcloud account", value: { statuses: ["local"], valid: isMaskedEmail }, bare: ["unconfirmed"] },
  },
  aws: { "aws.profiles": problemRow("AWS profiles") },
  npm: {
    "npm.config": problemRow("npm config"),
    "npm.registry": { label: "npm registry", value: { statuses: ["local"], valid: exactly(registryUrlShape) }, bare: [] },
    "npm.auth": { label: "npm sign-in", value: { statuses: ["local"], valid: (value) => value === "token saved" || value === "no token saved" }, bare: [] },
  },
  stamp: { "stamp.version": versionRow("Stamp CLI") },
  vercel: { "vercel.version": versionRow("Vercel CLI") },
};

/** The rule for a row's key in this check, or undefined for a key the check never emits. */
function ruleFor(id: ComputerCheckId, key: string): RowRule | undefined {
  // The runner's own row for a check that did not finish (or whose run folder was unusable).
  if (key === `${id}.check`) return problemRow(id);
  const fixed = FIXED_ROWS[id][key];
  if (fixed) return fixed;
  if (id === "github" && key.startsWith("github.account:")) {
    const host = key.slice("github.account:".length);
    if (hostnameShape(host) !== host) return undefined;
    return { label: `GitHub account (${host})`, value: { statuses: ["local"], valid: exactly(githubLoginShape) }, bare: [] };
  }
  if (id === "aws" && key.startsWith("aws.profile:")) {
    const name = key.slice("aws.profile:".length);
    if (!AWS_PROFILE.test(name)) return undefined;
    return { label: `AWS profile (${name})`, value: { statuses: ["local"], valid: exactly(awsRegionShape) }, bare: ["local"] };
  }
  return undefined;
}

export function isStoredRowValid(id: ComputerCheckId, item: CheckItem): boolean {
  // Text the Computer's own scrub would change (a credential, over 120 characters) was never emitted as is.
  if (scrubCheckText(item.key) !== item.key || scrubCheckText(item.label) !== item.label) return false;
  if (item.value !== undefined && scrubCheckText(item.value) !== item.value) return false;
  const rule = ruleFor(id, item.key);
  if (!rule || item.label !== rule.label) return false;
  if ((item.displayText === true) !== (rule.displayText === true && item.value !== undefined)) return false;
  if (item.value === undefined) {
    if (!rule.bare.includes(item.status)) return false;
    return item.status === "unconfirmed" ? item.reason !== undefined && isCheckUnconfirmedReason(item.reason) : item.reason === undefined;
  }
  return item.reason === undefined && rule.value !== undefined && rule.value.statuses.includes(item.status) && rule.value.valid(item.value);
}

/** Every row of a stored check is one the check could have produced; a check switched off by its owner has none. */
export function isStoredPluginValid(plugin: ComputerCheckPluginReport): boolean {
  if (plugin.disabledByOwner) return plugin.items.length === 0 && plugin.error === undefined;
  // A check emits each key once.
  if (new Set(plugin.items.map((item) => item.key)).size !== plugin.items.length) return false;
  return plugin.items.every((item) => isStoredRowValid(plugin.id, item));
}
