import { useCallback, useState } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import { setClockTimeout } from "@botiverse/raft-shared";
import { Check, ChevronRight, Copy, KeyRound } from "lucide-react";
import { Badge, Separator, Status, TextLink } from "@botiverse/raft-ui";
import SectionEyebrow from "../ui/SectionEyebrow";
import RuntimeSignInNotice from "../machine/RuntimeSignInNotice";
import { RUNTIME_INSTALL_COMMANDS } from "../machine/runtimeInstallCommands";
import type { RuntimeAuthClient } from "../../utils/runtimeAuthClient";
import type { RuntimeSignInState } from "../../utils/runtimeSignInState";
import type { ServerSetupRuntimeCatalogEntry } from "./ServerSetupComputerRuntimeStep";

/** Where a row's Sign In reads and acts: the Computer this step is connecting. */
export type ServerSetupRuntimeSignInTarget = {
  serverId: string;
  machineId: string;
  client?: RuntimeAuthClient;
};

export function RuntimeGroupLabel({ children, note }: { children: ReactNode; note?: string }) {
  return (
    <div className="px-3.5 pb-1 pt-3">
      <SectionEyebrow>{children}</SectionEyebrow>
      {note ? <span className="ml-2 text-caption text-foreground-hint">{note}</span> : null}
    </div>
  );
}

/**
 * One runtime on Screen B. A detected runtime the Computer reports signed out
 * says so on its chip ("Detected · not signed in") and, open, shows the same
 * notice and Sign In as the runtime picker (RuntimeSignInNotice) instead of
 * "ready to use" (mail #214: a bundled runtime is always detected).
 */
export function RuntimeRow({
  runtime,
  computerName,
  expanded,
  onToggle,
  onCopyInstallCommand,
  quiet = false,
  signIn = "unknown",
  signInTarget = null,
}: {
  runtime: ServerSetupRuntimeCatalogEntry;
  computerName: string | null;
  expanded: boolean;
  onToggle: (runtimeId: string) => void;
  onCopyInstallCommand?: (runtimeId: string, command: string) => void;
  quiet?: boolean;
  signIn?: RuntimeSignInState;
  signInTarget?: ServerSetupRuntimeSignInTarget | null;
}) {
  const { formatMessage } = useIntl();
  const command = RUNTIME_INSTALL_COMMANDS[runtime.id];
  const runtimeId = runtime.id;
  const handleToggle = useCallback(() => onToggle(runtimeId), [onToggle, runtimeId]);
  // Says so where the click happened, instead of throwing a toast across the screen.
  const [copied, setCopied] = useState(false);
  const handleCopyInstallCommand = useCallback(() => {
    if (!command || !onCopyInstallCommand) return;
    onCopyInstallCommand(runtimeId, command);
    setCopied(true);
    setClockTimeout(() => setCopied(false), 2_000);
  }, [command, onCopyInstallCommand, runtimeId]);
  const signedOut = runtime.detected && signIn === "signed_out";
  const computerLabel = computerName ?? formatMessage({ id: "onboarding.computerRuntime.yourComputer" });
  return (
    <>
    <Separator />
    <div className={expanded ? "bg-info-soft" : ""} data-testid={`onboarding-runtime-row-${runtime.id}`}>
      <button
        type="button"
        className={`flex min-h-11 w-full items-center gap-2.5 px-3.5 py-2 text-left outline-none hover:bg-fill-subtle focus-visible:shadow-[inset_0_0_0_2px_var(--foreground)] ${quiet ? "text-foreground-hint" : "text-foreground"}`}
        aria-expanded={expanded}
        onClick={handleToggle}
      >
        <span className={`flex shrink-0 items-center justify-center bg-fill-muted font-mono text-mono-meta font-bold text-foreground-muted ${runtime.recommended ? "size-[27px] rounded-chip" : "size-6 rounded-sticker"}`}>
          {runtime.abbreviation}
        </span>
        <span className="min-w-0 flex-1">
          <span className={`block font-semibold ${runtime.recommended ? "text-callout" : "text-footnote"}`}>
            {runtime.displayName}
            {/* Where the picker's list puts it: after the name, the outline badge the runtime picker uses for Recommended and Limited. */}
            {runtime.limited ? (
              <>
                {" "}
                <Badge appearance="outline" className="align-middle" data-testid={`onboarding-runtime-limited-${runtime.id}`}>
                  {formatMessage({ id: "runtime.picker.limited" })}
                </Badge>
              </>
            ) : null}
          </span>
          {/* What it lacks in Raft: muted, under the name, as a select option's description. */}
          {runtime.capabilityHintId ? (
            <span className="block text-caption font-normal text-foreground-hint" data-testid={`onboarding-runtime-hint-${runtime.id}`}>
              {formatMessage({ id: runtime.capabilityHintId })}
            </span>
          ) : null}
        </span>
        {/* DS StatusChip: a soft wash, a square pixel, one short label. Signed out is
            something to fix: warning. */}
        <Badge variant={signedOut ? "warning" : runtime.detected ? "success" : "muted"} appearance="soft" className="shrink-0">
          <Status variant={signedOut ? "warning" : runtime.detected ? "success" : "default"} aria-hidden="true" />
          {formatMessage({
            id: signedOut
              ? "onboarding.computerRuntime.detectedNotSignedIn"
              : runtime.detected
                ? "onboarding.computerRuntime.detected"
                : "onboarding.computerRuntime.notDetected",
          })}
        </Badge>
        <ChevronRight size={16} className={`shrink-0 text-foreground-muted transition-transform ${expanded ? "rotate-90" : ""}`} />
      </button>
      {expanded ? (
        <div className="px-3.5 pb-3 pl-12 text-footnote text-foreground-muted">
          {signedOut && signInTarget ? (
            <RuntimeSignInNotice
              serverId={signInTarget.serverId}
              machineId={signInTarget.machineId}
              machineName={computerLabel}
              runtimeId={runtime.id}
              enabled
              client={signInTarget.client}
            />
          ) : runtime.detected ? (
            <p>
              {/* Was a sentence plus a leading-space fragment concatenated in JSX.
                  Two whole messages instead: a translation cannot be expected to
                  produce a trailing clause that happens to start with a space. */}
              {formatMessage(
                {
                  id: runtime.id === "claude" && !signedOut
                    ? "onboarding.computerRuntime.runtimeFoundBestTested"
                    : "onboarding.computerRuntime.runtimeFound",
                },
                {
                  computer: computerLabel,
                  b: (chunks: ReactNode) => <strong key="b" className="text-foreground">{chunks}</strong>,
                },
              )}
            </p>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p>
                {formatMessage(
                  { id: "onboarding.computerRuntime.runtimeInstallHint" },
                  {
                    runtime: runtime.displayName,
                    b: (chunks: ReactNode) => <strong key="b" className="text-foreground">{chunks}</strong>,
                  },
                )}
              </p>
              {command && onCopyInstallCommand ? (
                <TextLink
                  onClick={handleCopyInstallCommand}
                  className="inline-flex items-center gap-1"
                >
                  {copied ? <Check size={12} strokeWidth={3} /> : <Copy size={12} />}
                  {formatMessage({
                    id: copied
                      ? "onboarding.computerRuntime.copied"
                      : "onboarding.computerRuntime.copyInstallCommand",
                  })}
                </TextLink>
              ) : null}
            </div>
          )}
        </div>
      ) : null}
    </div>
    </>
  );
}

export function OwnApiKeyRow({
  expanded,
  onToggle,
  onOpenSettings,
}: {
  expanded: boolean;
  onToggle: () => void;
  onOpenSettings?: () => void;
}) {
  const { formatMessage } = useIntl();
  return (
    <>
    <Separator />
    <div className={expanded ? "bg-info-soft" : ""}>
      <button type="button" className="flex min-h-11 w-full items-center gap-2.5 px-3.5 py-2 text-left text-foreground outline-none hover:bg-fill-subtle focus-visible:shadow-[inset_0_0_0_2px_var(--foreground)]" aria-expanded={expanded} onClick={onToggle}>
        <span className="flex size-6 shrink-0 items-center justify-center rounded-sticker bg-fill-muted text-foreground-muted">
          <KeyRound size={14} />
        </span>
        <span className="min-w-0 flex-1 text-footnote font-semibold">
          {formatMessage({ id: "onboarding.computerRuntime.ownApiKey" })}
        </span>
        <Badge variant="muted" appearance="soft" className="shrink-0">
          {formatMessage({ id: "onboarding.computerRuntime.notSet" })}
        </Badge>
        <ChevronRight size={16} className={`shrink-0 text-foreground-muted transition-transform ${expanded ? "rotate-90" : ""}`} />
      </button>
      {expanded ? (
        <div className="flex flex-wrap items-center justify-between gap-2 px-3.5 pb-3 pl-12 text-footnote text-foreground-muted">
          <p>
            {formatMessage({ id: "onboarding.computerRuntime.ownApiKeyHint" })}
          </p>
          {onOpenSettings ? (
            <TextLink onClick={onOpenSettings}>
              {formatMessage({ id: "onboarding.computerRuntime.addApiKey" })}
            </TextLink>
          ) : null}
        </div>
      ) : null}
    </div>
    </>
  );
}
