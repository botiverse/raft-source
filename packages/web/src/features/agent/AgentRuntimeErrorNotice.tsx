import { Button, CopyableCode, CopyableCodeAction, CopyableCodeRoot, PanelNotice, PanelNoticeActions, PanelNoticeContent, TextLink } from "@botiverse/raft-ui";
import { useCallback, useMemo, useRef, useState } from "react";
import { useIntl } from "react-intl";
import { TriangleAlert } from "lucide-react";
import { clearClockTimeout, setClockTimeout } from "@botiverse/raft-shared";
import Tooltip from "../../components/ui/Tooltip";
import { DEFAULT_COPY_FEEDBACK_TIMEOUT_MS } from "../../hooks/useCopyText";
import type { RuntimeErrorCode } from "@botiverse/raft-shared";
import { RUNTIME_ERROR_CODE_MESSAGE_ID } from "../../utils/classifyRuntimeError";
import type { RuntimeErrorKind } from "../../utils/classifyRuntimeError";

/**
 * The agent panel's runtime error banner, shown while the agent has a runtime
 * error (the stored `lastRuntimeError` or an error activity; the panel decides).
 *
 * Error detail leaks via Socket.io `agent:activity` to all server members, so
 * for non-creators (`canViewDetails` false) it falls back to a generic message
 * and hides the copy-info and "View logs".
 *
 * task #1351: a typed BillingError (`runtimeErrorKind` "billingExhausted",
 * reached only from the typed carrier) gets its own banner: a title, a body
 * naming the agent, and one action — "View model settings" for whoever may
 * open them, otherwise who can fix it. It is catalog copy, so every viewer
 * gets it; the raw 402 text stays in the copy-info diagnostics. It has no
 * dismissal of its own: it goes when the panel stops passing the error.
 *
 * #wg-rbac:#57: the server sends members no error text, only the error's
 * code. A member reads the code's sentence (catalog copy), or the generic
 * fallback when there is no code. The agent's managers read the code's
 * sentence as the headline, with the (server-scrubbed) detail under it.
 */
export function AgentRuntimeErrorNotice({ errorText, canViewDetails, runtimeErrorKind, runtimeErrorCode = null, errorDetail = "", agentTitle, getDiagnosticInfo, onOpenModelSettings, showAskAdmin, onViewLogs }: {
  /** The classified catalog copy, or the raw text / generic fallback. */
  errorText: string;
  canViewDetails: boolean;
  runtimeErrorKind: RuntimeErrorKind | null;
  /** The error's code (every viewer gets it), or null. */
  runtimeErrorCode?: RuntimeErrorCode | null;
  /** The error's detail text, for a viewer who may see it (empty otherwise). */
  errorDetail?: string;
  agentTitle: string;
  getDiagnosticInfo: () => string;
  /** Present when the viewer may open the agent's model settings. */
  onOpenModelSettings?: () => void;
  /** Whether the billing banner says who can fix it when it has no action (not on the mobile activity-only page). */
  showAskAdmin: boolean;
  /** Present when the Activity tab is not the one shown. */
  onViewLogs?: () => void;
}) {
  const { formatMessage } = useIntl();
  const billingExhausted = runtimeErrorKind === "billingExhausted";
  const fallbackText = formatMessage({ id: "activity.status.agentErrorFallback" });
  const codeMessageIds = runtimeErrorCode ? RUNTIME_ERROR_CODE_MESSAGE_ID[runtimeErrorCode] : null;
  const headline = canViewDetails
    ? (codeMessageIds ? formatMessage({ id: codeMessageIds.manager }) : errorText)
    : (codeMessageIds ? formatMessage({ id: codeMessageIds.member }) : fallbackText);
  // A manager's detail goes under the code's headline; without a code the headline is the detail already.
  const detailLine = canViewDetails && codeMessageIds && errorDetail.trim() ? errorDetail.trim() : null;

  // The compact diagnostic copy: the RUI CopyableCodeAction reads its value
  // from the visually hidden CopyableCode, and this state drives its tooltip.
  // The profile tab's full-width control keeps its own lifecycle.
  const diagnosticInfoText = useMemo(() => getDiagnosticInfo(), [getDiagnosticInfo]);
  const [copied, setCopied] = useState(false);
  const copiedResetRef = useRef<unknown>(null);
  const markCopied = useCallback(() => {
    clearClockTimeout(copiedResetRef.current);
    setCopied(true);
    copiedResetRef.current = setClockTimeout(() => setCopied(false), DEFAULT_COPY_FEEDBACK_TIMEOUT_MS);
  }, []);
  const copyLabel = copied ? formatMessage({ id: "agent.detail.copied" }) : formatMessage({ id: "agent.detail.copyInfo" });

  return (
    <PanelNotice data-testid="agent-runtime-error-banner" data-runtime-error-kind={runtimeErrorKind ?? undefined} data-runtime-error-code={runtimeErrorCode ?? undefined}>
      <TriangleAlert aria-hidden className="size-4" />
      {billingExhausted ? (
        // Never a reset, never the provider's name: the copy is typed, not the 402 text.
        <PanelNoticeContent className="break-words" data-testid="agent-billing-banner">
          <div>{errorText}</div>
          <div className="font-normal text-foreground-muted">
            {formatMessage({ id: "agent.runtimeError.billingExhaustedBody" }, { agent: agentTitle })}
          </div>
          {!onOpenModelSettings && showAskAdmin && (
            <div className="font-normal text-foreground-muted" data-testid="agent-billing-banner-ask-admin">
              {formatMessage({ id: "agent.runtimeError.billingExhaustedAskAdmin" })}
            </div>
          )}
        </PanelNoticeContent>
      ) : detailLine ? (
        <PanelNoticeContent className="min-w-0 break-words" data-testid="agent-runtime-error-headline">
          <div>{headline}</div>
          <Tooltip content={detailLine}>
            <div className="line-clamp-2 font-normal text-foreground-muted" data-testid="agent-runtime-error-detail">{detailLine}</div>
          </Tooltip>
        </PanelNoticeContent>
      ) : (
        <Tooltip content={headline}><PanelNoticeContent render={<span />} className="line-clamp-2 break-words">
          {headline}
        </PanelNoticeContent></Tooltip>
      )}
      {(canViewDetails || (billingExhausted && onOpenModelSettings)) && (
        <PanelNoticeActions>
          {billingExhausted && onOpenModelSettings && (
            <Button variant="ghost" size="md" onClick={onOpenModelSettings} data-testid="agent-billing-banner-model-settings">
              {formatMessage({ id: "agent.runtimeError.billingExhaustedViewModelSettings" })}
            </Button>
          )}
          {canViewDetails && (
            <Tooltip content={copyLabel}>
              <CopyableCodeRoot
                size="sm"
                copied={copied}
                onCopy={markCopied}
                className="w-auto shrink-0"
                // The Tooltip trigger merge keeps a child's declared data-slot;
                // without it the action's own closest() lookup for the root fails.
                data-slot="copyable-code-root"
              >
                <CopyableCode className="sr-only" aria-hidden="true">{diagnosticInfoText}</CopyableCode>
                <CopyableCodeAction aria-label={copyLabel} />
              </CopyableCodeRoot>
            </Tooltip>
          )}
          {/* The billing banner keeps one action (its copy rule); its log is still on the Activity tab. */}
          {canViewDetails && onViewLogs && !billingExhausted && (
            <TextLink onClick={onViewLogs} className="whitespace-nowrap text-footnote">
              {formatMessage({ id: "agent.detail.viewLogs" })}
            </TextLink>
          )}
        </PanelNoticeActions>
      )}
    </PanelNotice>
  );
}
