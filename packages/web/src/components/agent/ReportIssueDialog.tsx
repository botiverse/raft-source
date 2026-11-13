import { feedbackTicketPath } from "../../feedback/feedbackPaths";
import { Card, Checkbox, Textarea, Button } from "@botiverse/raft-ui";
import { FEEDBACK_REPORT_SESSION_RECORD_EVENT } from "@botiverse/raft-shared";
import type { FeedbackReportSessionRecordEvent } from "@botiverse/raft-shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CircleCheck } from "lucide-react";
import { useIntl } from "react-intl";
import { useNavigate } from "react-router-dom";
import type { IntlShape } from "react-intl";
import type { MessageId } from "../../i18n/messages";
import DialogCard from "../ui/DialogCard";
import Banner from "../ui/Banner";
import SectionEyebrow from "../ui/SectionEyebrow";
import FormField from "../ui/FormField";
import api from "../../api/client";
import { getSocket } from "../../api/socket";
import { createAgentIssueTicket } from "../../feedback/agentIssueTicket";
import { nextTranscriptRequestState, sessionRecordAnswerFor, startTranscriptRequest } from "../../feedback/transcriptRequestState";
import type { TranscriptRequestState } from "../../feedback/transcriptRequestState";
import { useAuthStore } from "../../store/authStore";
import { useServerStore } from "../../store/serverStore";
import { useAgentStore } from "../../store/agentStore";
import type { Agent } from "../../store/agentStore";
import { useMachineStore } from "../../store/machineStore";
import { buildFeedbackExportBundle, snapshotAgentMachine } from "../../utils/feedbackExportBundle";
import type { FeedbackExportBundleV2 } from "../../utils/feedbackExportBundle";
import { detectBrowserTimezone } from "../../utils/timeFormatting";
import { WEB_APP_VERSION } from "../../utils/webAppVersion";
import { DialogCardFooter, DialogCommit } from "../ui/NarrowDialog";

interface ReportIssueDialogProps {
  agent: Agent;
  dmChannelId?: string;
  onClose: () => void;
  feedbackExportUrl?: string;
}

const FEEDBACK_EXPORT_URL = import.meta.env?.VITE_FEEDBACK_EXPORT_URL?.replace(/\/+$/, "") || "";
const VERSION_ENV = import.meta.env ?? {};
const FEEDBACK_APP_VERSION = [
  WEB_APP_VERSION,
  VERSION_ENV.VITE_COMMIT_SHA?.trim(),
].filter(Boolean).join("+") || null;

type ScopeAttestationResponse = {
  attestation: string;
  scope: string;
  expiresAt: string;
};

type CreateReportResponse = {
  id: string;
  artifactId?: string;
  upload: {
    method: "PUT";
    url: string;
    headers: Record<string, string>;
  };
  completeToken: string;
  expiresAt: string;
};

const TRANSCRIPT_REQUEST_STATE_COPY: Record<TranscriptRequestState, MessageId> = {
  pending: "agent.reportIssue.runtimeTranscriptRequestPending",
  requested: "agent.reportIssue.runtimeTranscriptRequested",
  request_failed: "agent.reportIssue.runtimeTranscriptRequestFailed",
  request_unconfirmed: "agent.reportIssue.runtimeTranscriptRequestUnconfirmed",
  attached: "agent.reportIssue.runtimeTranscriptAttached",
  not_attached: "agent.reportIssue.runtimeTranscriptNotAttached",
};

type SubmittedReport = {
  reportId: string;
  // Null when the bundle uploaded but filing the Hands ticket failed; the
  // report id is then the only handle the user can pass on.
  ticketId: string | null;
  // Kept so a failed ticket can be retried with the same submission id, which
  // Hands uses to dedupe: a retry after a lost response cannot file twice.
  ticketRequest: Parameters<typeof createAgentIssueTicket>[0];
  serverId: string;
  serverSlug: string | null;
  issueDescription?: string;
  transcriptAttachmentRequested: boolean;
};

function readNestedErrorMessage(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const direct = record.error ?? record.message;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  if (record.data && typeof record.data === "object") {
    return readNestedErrorMessage(record.data);
  }
  return null;
}

function describeUnknownError(
  error: unknown,
  formatMessage: IntlShape["formatMessage"],
): string {
  const nested = readNestedErrorMessage(error);
  if (nested) return nested;
  if (error instanceof Error && error.message) return error.message;
  return formatMessage({ id: "agent.reportIssue.unknownError" });
}

function describeApiFailure(
  error: unknown,
  formatMessage: IntlShape["formatMessage"],
): string {
  if (!error || typeof error !== "object") return describeUnknownError(error, formatMessage);
  const record = error as Record<string, unknown>;
  const response = record.response;
  if (!response || typeof response !== "object") return describeUnknownError(error, formatMessage);
  const responseRecord = response as Record<string, unknown>;
  const status = typeof responseRecord.status === "number" ? responseRecord.status : null;
  const detail = readNestedErrorMessage(responseRecord.data) ?? describeUnknownError(error, formatMessage);
  return status
    ? formatMessage({ id: "agent.reportIssue.httpError" }, { status, detail })
    : detail;
}

function stepError(stepLabel: string, detail: string): Error {
  return new Error(`${stepLabel}: ${detail}`);
}

async function describeFetchFailure(
  response: Response,
  fallback: string,
  formatMessage: IntlShape["formatMessage"],
): Promise<string> {
  const body = await response.clone().json().catch(() => null) as unknown;
  const bodyMessage = readNestedErrorMessage(body);
  const detail = bodyMessage || (await response.text().catch(() => "")) || fallback;
  return formatMessage(
    { id: "agent.reportIssue.httpError" },
    { status: response.status, detail },
  );
}

// Resolves to null on failure: the bundle is already uploaded, so a Hands
// outage must not fail the report itself.
function fileTicket(request: Parameters<typeof createAgentIssueTicket>[0]): Promise<string | null> {
  return createAgentIssueTicket(request).then(
    (ticket) => ticket.id,
    (err) => {
      console.warn("[ReportIssueDialog] Failed to file the feedback ticket", err);
      return null;
    },
  );
}

function buildExportFilename(agent: Agent) {
  const safeName = (agent.displayName || agent.name)
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "agent";
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `slock-feedback-export-${safeName}-${timestamp}.json`;
}

async function sha256Hex(blob: Blob) {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export default function ReportIssueDialog({
  agent,
  dmChannelId,
  onClose,
  feedbackExportUrl = FEEDBACK_EXPORT_URL,
}: ReportIssueDialogProps) {
  const { formatMessage, locale } = useIntl();
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const server = useServerStore((s) => s.current);
  const getActivityLog = useAgentStore((s) => s.getActivityLog);
  const getTrajectoryLog = useAgentStore((s) => s.getTrajectoryLog);
  const machines = useMachineStore((s) => s.machines);
  const machine = useMemo(
    () => (agent.machineId ? machines.find((entry) => entry.id === agent.machineId) : null),
    [agent.machineId, machines]
  );

  const [description, setDescription] = useState("");
  const [includeRecentMessages, setIncludeRecentMessages] = useState(true);
  const [includeActivityLog, setIncludeActivityLog] = useState(true);
  const [includeTrajectoryLog, setIncludeTrajectoryLog] = useState(true);
  const [includeSessionTranscript, setIncludeSessionTranscript] = useState(Boolean(agent.machineId));
  // Tier 2 (task #272): machine runner log tail, offered only to the human who
  // attached the machine; the server re-checks ownership. task #279 (artin):
  // for the reporter's OWN machine it defaults ON — most reports never carried
  // it while it was off — and stays a visible, untickable box with disclosure.
  const canIncludeMachineLog = Boolean(agent.machineId && machine?.computerAttachedByCurrentUser);
  // The machine list can load after the dialog mounts, so the default is
  // DERIVED from ownership at render time rather than captured at mount: until
  // the user touches the box it follows `canIncludeMachineLog`; once touched,
  // the user's choice wins and later store updates cannot re-tick it
  // (Jianwei, #7798 review).
  const [machineLogTailChoice, setMachineLogTailChoice] = useState<boolean | null>(null);
  const includeMachineLogTail = machineLogTailChoice ?? canIncludeMachineLog;
  const [consented, setConsented] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [submittedReport, setSubmittedReport] = useState<SubmittedReport | null>(null);
  const [reportRefCopied, setReportRefCopied] = useState(false);
  const [ticketRetrying, setTicketRetrying] = useState(false);
  // task #1228 ①: the HTTP result of our own request, until the server pushes
  // what the agent's computer answered for this report (the effect below).
  const [transcriptRequestState, setTranscriptRequestState] = useState<TranscriptRequestState | null>(null);
  // The report whose session record this dialog requested, from the moment the
  // request starts (before the ticket is filed and the success screen shows).
  const transcriptRequestReportIdRef = useRef<string | null>(null);
  const acceptTranscriptRequestState = useCallback((incoming: TranscriptRequestState) => {
    setTranscriptRequestState((current) => nextTranscriptRequestState(current, incoming));
  }, []);

  // What the agent's computer answered about the session record is pushed on
  // the socket, after the request itself was answered 202. Only the answer for
  // this dialog's report applies; it is final (nextTranscriptRequestState).
  useEffect(() => {
    const socket = getSocket();
    const onSessionRecord = (payload: Partial<FeedbackReportSessionRecordEvent> | null | undefined) => {
      const answer = sessionRecordAnswerFor(payload, transcriptRequestReportIdRef.current);
      if (answer) acceptTranscriptRequestState(answer);
    };
    socket.on(FEEDBACK_REPORT_SESSION_RECORD_EVENT, onSessionRecord);
    return () => {
      socket.off(FEEDBACK_REPORT_SESSION_RECORD_EVENT, onSessionRecord);
    };
  }, [acceptTranscriptRequestState]);

  const handleSubmit = useCallback(async () => {
    if (!consented || loading) return;
    if (!feedbackExportUrl) {
      setError(formatMessage({ id: "agent.reportIssue.exportNotConfigured" }));
      return;
    }
    if (!server?.id) {
      setError(formatMessage({ id: "agent.reportIssue.serverUnavailable" }));
      return;
    }

    setLoading(true);
    setError(null);

    try {
      let recentMessages: unknown[] | null = null;
      if (includeRecentMessages && dmChannelId) {
        try {
          const { data } = await api.get(`/messages/channel/${dmChannelId}?limit=100`);
          recentMessages = Array.isArray(data?.messages) ? data.messages : [];
        } catch (err) {
          throw stepError(formatMessage({ id: "agent.reportIssue.stepCollectFailed" }), describeApiFailure(err, formatMessage));
        }
      }

      let bundle: FeedbackExportBundleV2;
      let bundleFile: File;
      let bundleSha256: string;
      try {
        const activityLog = includeActivityLog ? getActivityLog(agent.id) : null;
        const trajectoryLog = includeTrajectoryLog ? getTrajectoryLog(agent.id) : null;

        const { daemonVersion, ...machineSnapshot } = snapshotAgentMachine(machine);
        bundle = buildFeedbackExportBundle({
          appVersion: FEEDBACK_APP_VERSION,
          daemonVersion,
          reporter: {
            id: user?.id ?? null,
            email: user?.email ?? null,
            name: user?.name ?? null,
            displayName: user?.displayName ?? null,
          },
          server: {
            id: server.id,
            slug: server.slug ?? null,
            name: server.name ?? null,
          },
          agent: {
            id: agent.id,
            name: agent.name,
            displayName: agent.displayName,
            description: agent.description,
            status: agent.status,
            runtime: agent.runtime,
            model: agent.model,
            reasoningEffort: agent.reasoningEffort,
            machineId: agent.machineId,
            ...machineSnapshot,
          },
          recentMessages,
          ephemeralActivityBuffer: activityLog,
          durableTrajectoryLog: trajectoryLog,
          includeRecentMessages,
          includeEphemeralActivityBuffer: includeActivityLog,
          includeDurableTrajectoryLog: includeTrajectoryLog,
          description,
          browser: {
            url: window.location.href,
            userAgent: navigator.userAgent,
            language: navigator.language,
            languages: navigator.languages,
            platform: navigator.platform,
            timezone: detectBrowserTimezone() ?? "unknown",
            viewport: {
              width: window.innerWidth,
              height: window.innerHeight,
            },
            screen: {
              width: window.screen.width,
              height: window.screen.height,
            },
          },
        });

        bundleFile = new File(
          [JSON.stringify(bundle, null, 2)],
          buildExportFilename(agent),
          { type: "application/json" }
        );
        bundleSha256 = await sha256Hex(bundleFile);
      } catch (err) {
        throw stepError(formatMessage({ id: "agent.reportIssue.stepCollectFailed" }), describeUnknownError(err, formatMessage));
      }

      let session: ScopeAttestationResponse;
      try {
        const { data } = await api.post<ScopeAttestationResponse>(
          `/servers/${server.id}/scope-attestation`,
          { scope: "feedback-report:create" }
        );
        session = data;
      } catch (err) {
        throw stepError(formatMessage({ id: "agent.reportIssue.stepAttestationFailed" }), describeApiFailure(err, formatMessage));
      }

      const createResponse = await fetch(`${feedbackExportUrl}/api/reports`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          attestation: session.attestation,
          agentId: agent.id,
          agentName: agent.displayName || agent.name,
          bundleFilename: bundleFile.name,
          bundleContentType: bundleFile.type || "application/json",
          bundleSizeBytes: bundleFile.size,
          bundleSha256,
          source: "slock-web",
          category: "bug",
          title: formatMessage(
            { id: "agent.reportIssue.titleForAgent" },
            { name: agent.displayName || agent.name },
          ),
          description: description.trim() || undefined,
          appVersion: bundle.appVersion ?? undefined,
          daemonVersion: bundle.daemonVersion ?? undefined,
          metadata: {
            schemaVersion: bundle.schemaVersion,
            reportGeneratedAt: bundle.generatedAt,
            dmChannelId: dmChannelId || null,
            deploymentEnv: VERSION_ENV.VITE_DEPLOYMENT_ENV || null,
            includes: {
              recentMessages: bundle.logs.recentMessages.included,
              activityLog: bundle.logs.ephemeralActivityBuffer.included,
              trajectoryLog: bundle.logs.durableTrajectoryLog.included,
              ephemeralActivityBuffer: bundle.logs.ephemeralActivityBuffer.included,
              durableTrajectoryLog: bundle.logs.durableTrajectoryLog.included,
              ...(agent.machineId ? { runtimeSessionTranscript: includeSessionTranscript } : {}),
            },
            ...(agent.machineId
              ? {
                  transcript: {
                    attachmentMode: "async_trace_bundle",
                    requested: includeSessionTranscript,
                    requestable: true,
                    skippedReason: null,
                  },
                }
              : {}),
          },
        }),
      });

      if (!createResponse.ok) {
        throw stepError(
          formatMessage({ id: "agent.reportIssue.stepCreateFailed" }),
          await describeFetchFailure(createResponse, formatMessage({ id: "agent.reportIssue.createFeedbackFailed" }), formatMessage),
        );
      }

      const report = await createResponse.json() as CreateReportResponse;

      const uploadResponse = await fetch(report.upload.url, {
        method: report.upload.method,
        headers: report.upload.headers,
        body: bundleFile,
      });
      if (!uploadResponse.ok) {
        throw stepError(
          formatMessage({ id: "agent.reportIssue.stepUploadFailed" }),
          await describeFetchFailure(uploadResponse, formatMessage({ id: "agent.reportIssue.uploadFeedbackFailed" }), formatMessage),
        );
      }

      const completeResponse = await fetch(`${feedbackExportUrl}/api/reports/${report.id}/complete`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          completeToken: report.completeToken,
        }),
      });
      if (!completeResponse.ok) {
        throw stepError(
          formatMessage({ id: "agent.reportIssue.stepCompleteFailed" }),
          await describeFetchFailure(completeResponse, formatMessage({ id: "agent.reportIssue.finalizeFeedbackFailed" }), formatMessage),
        );
      }

      const transcriptAttachmentRequested = includeSessionTranscript && Boolean(agent.machineId);
      if (transcriptAttachmentRequested && agent.machineId) {
        const machineId = agent.machineId;
        // Started BEFORE the ticket and never awaited by the submission: the
        // state updates on its own (10 s cap measured from this start), and
        // the helper's promise never rejects. The answer push is matched to
        // this report from here on: it can arrive before the request's 202.
        transcriptRequestReportIdRef.current = report.id;
        startTranscriptRequest(
          () => api.post(
            `/servers/${server.id}/machines/${machineId}/agents/${agent.id}/feedback/${report.id}/transcript`,
            {
              reportGeneratedAt: bundle.generatedAt,
              ...(canIncludeMachineLog && includeMachineLogTail ? { includeMachineLogTail: true } : {}),
            }
          ).catch((err: unknown) => {
            console.warn("[ReportIssueDialog] Session record request failed", describeApiFailure(err, formatMessage));
            throw err;
          }),
          acceptTranscriptRequestState,
        );
      }

      const agentTitle = formatMessage(
        { id: "agent.reportIssue.titleForAgent" },
        { name: agent.displayName || agent.name },
      );
      const ticketRequest = {
        message: [agentTitle, description.trim()].filter(Boolean).join("\n\n"),
        feedbackReportId: report.id,
        submissionId: crypto.randomUUID(),
        // The same react-intl locale that formatted agentTitle above.
        locale,
      };
      const ticketId = await fileTicket(ticketRequest);

      setSubmittedReport({
        reportId: report.id,
        ticketId,
        ticketRequest,
        serverId: server.id,
        serverSlug: server.slug ?? null,
        issueDescription: description.trim() || undefined,
        transcriptAttachmentRequested,
      });
      setSubmitted(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : formatMessage({ id: "agent.reportIssue.submitFailed" }));
    } finally {
      setLoading(false);
    }
  }, [acceptTranscriptRequestState, agent, canIncludeMachineLog, consented, description, dmChannelId, feedbackExportUrl, formatMessage, locale, getActivityLog, getTrajectoryLog, includeActivityLog, includeMachineLogTail, includeRecentMessages, includeSessionTranscript, includeTrajectoryLog, loading, machine, server, user]);

  const handleRetryTicket = useCallback(async () => {
    if (!submittedReport || submittedReport.ticketId) return;
    setTicketRetrying(true);
    try {
      const ticketId = await fileTicket(submittedReport.ticketRequest);
      if (ticketId) setSubmittedReport({ ...submittedReport, ticketId });
    } finally {
      setTicketRetrying(false);
    }
  }, [submittedReport]);

  const handleCopyReportReference = useCallback(async () => {
    if (!submittedReport) return;
    const lines = [
      `reportId: ${submittedReport.reportId}`,
      `serverId: ${submittedReport.serverId}`,
      submittedReport.issueDescription ? `issueDescription:\n${submittedReport.issueDescription}` : null,
    ].filter(Boolean);
    await navigator.clipboard.writeText(lines.join("\n"));
    setReportRefCopied(true);
  }, [submittedReport]);

  const handleDescriptionChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setDescription(e.target.value);
  }, []);

  const handleRecentMessagesChange = useCallback((checked: boolean) => {
    setIncludeRecentMessages(checked);
  }, []);

  const handleActivityLogChange = useCallback((checked: boolean) => {
    setIncludeActivityLog(checked);
  }, []);

  const handleTrajectoryLogChange = useCallback((checked: boolean) => {
    setIncludeTrajectoryLog(checked);
  }, []);

  const handleSessionTranscriptChange = useCallback((checked: boolean) => {
    setIncludeSessionTranscript(checked);
  }, []);

  const handleMachineLogTailChange = useCallback((checked: boolean) => {
    setMachineLogTailChoice(checked);
  }, []);

  const handleConsentedChange = useCallback((checked: boolean) => {
    setConsented(checked);
  }, []);

  const ticketPath = submittedReport?.ticketId
    ? feedbackTicketPath(submittedReport.serverSlug, submittedReport.ticketId)
    : null;

  const handleViewTicket = useCallback(() => {
    if (!ticketPath) return;
    onClose();
    navigate(ticketPath);
  }, [onClose, navigate, ticketPath]);

  if (submitted) {
    return (
      <DialogCard title={formatMessage({ id: "agent.reportIssue.submittedTitle" })} onClose={onClose} maxWidthClass="max-w-sm">
          <div className="flex flex-col items-center gap-4 py-4">
            <div className="flex size-12 items-center justify-center rounded-sticker border-[1.5px] border-sticker-ink bg-success text-sticker-ink">
              <CircleCheck size={24} aria-hidden="true" />
            </div>
            <div className="text-center">
              <p className="text-subhead font-bold text-foreground">{formatMessage({ id: "agent.reportIssue.uploaded" })}</p>
              <p className="mt-1 text-callout text-foreground-muted">
                {formatMessage({ id: submittedReport?.ticketId ? "agent.reportIssue.ticketFiled" : "agent.reportIssue.uploadedDescription" })}
              </p>
            </div>
            {submittedReport && !submittedReport.ticketId && (
              <Card className="block w-full p-3 text-left">
                <Banner intent="warning" density="sm" className="mb-3" role="alert">
                  {formatMessage({ id: "agent.reportIssue.ticketFailed" })}
                </Banner>
                <SectionEyebrow as="div" className="mb-1">{formatMessage({ id: "agent.reportIssue.reportReference" })}</SectionEyebrow>
                <dl className="stack-y-1">
                  <div>
                    <dt className="text-caption font-semibold text-foreground-muted">{formatMessage({ id: "agent.reportIssue.reportId" })}</dt>
                    <dd className="break-all font-mono text-mono-meta text-foreground">{submittedReport.reportId}</dd>
                  </div>
                  <div>
                    <dt className="text-caption font-semibold text-foreground-muted">{formatMessage({ id: "agent.reportIssue.serverId" })}</dt>
                    <dd className="break-all font-mono text-mono-meta text-foreground">{submittedReport.serverId}</dd>
                  </div>
                </dl>
                <Button size="md"
                  variant="outline"
                  type="button"
                  onClick={handleCopyReportReference}
                  className="mt-3"
                >
                  {formatMessage({ id: reportRefCopied ? "agent.reportIssue.copied" : "agent.reportIssue.copyReference" })}
                </Button>
                <Button size="md"
                  variant="outline"
                  type="button"
                  onClick={handleRetryTicket}
                  disabled={ticketRetrying}
                  className="mt-3 ml-2"
                >
                  {formatMessage({ id: ticketRetrying ? "agent.reportIssue.retryingTicket" : "agent.reportIssue.retryTicket" })}
                </Button>
              </Card>
            )}
            {submittedReport?.transcriptAttachmentRequested && transcriptRequestState && (
              <p className="text-caption text-foreground-hint" role="status">
                {formatMessage({ id: TRANSCRIPT_REQUEST_STATE_COPY[transcriptRequestState] })}
              </p>
            )}
          </div>
          <DialogCardFooter>
            {ticketPath && (
              <Button size="lg"
                variant="outline"
                type="button"
                onClick={handleViewTicket}
              >
                {formatMessage({ id: "agent.reportIssue.viewTicket" })}
              </Button>
            )}
            <Button size="lg" variant="primary" type="button" onClick={onClose}>
              {formatMessage({ id: "agent.reportIssue.done" })}
            </Button>
          </DialogCardFooter>
      </DialogCard>
    );
  }

  return (
    <DialogCard
      title={formatMessage({ id: "agent.reportIssue.title" })}
      onClose={onClose}
      maxWidthClass="max-w-sm"
      narrow="sheet"
    >

        <Card className="mb-4 block px-3 py-2">
          <SectionEyebrow>{formatMessage({ id: "agent.reportIssue.agentLabel" })}</SectionEyebrow>
          <p className="mt-0.5 text-subhead font-semibold text-foreground">{agent.displayName || agent.name}</p>
        </Card>

        <FormField label={formatMessage({ id: "agent.reportIssue.describeLabel" })} optional className="mb-4">
          <Textarea
            className="w-full resize-none"
            rows={3}
            placeholder={formatMessage({ id: "agent.reportIssue.describePlaceholder" })}
            value={description}
            onChange={handleDescriptionChange}
            disabled={loading}
          />
        </FormField>

        <div className="mb-4">
          <SectionEyebrow as="div" className="mb-1">{formatMessage({ id: "agent.reportIssue.includeLabel" })}</SectionEyebrow>
          <div className="flex flex-col gap-1">
            <label className="flex min-h-8 select-none items-center gap-2 has-[[data-disabled]]:text-foreground-disabled">
              <Checkbox
                checked={includeRecentMessages}
                onCheckedChange={handleRecentMessagesChange}
                disabled={loading}
              />
              <span className="text-callout font-semibold">{formatMessage({ id: "agent.reportIssue.includeRecentMessages" })}</span>
            </label>
            <label className="flex min-h-8 select-none items-center gap-2 has-[[data-disabled]]:text-foreground-disabled">
              <Checkbox
                checked={includeActivityLog}
                onCheckedChange={handleActivityLogChange}
                disabled={loading}
              />
              <span className="text-callout font-semibold">{formatMessage({ id: "agent.reportIssue.includeLiveActivity" })}</span>
            </label>
            <label className="flex min-h-8 select-none items-center gap-2 has-[[data-disabled]]:text-foreground-disabled">
              <Checkbox
                checked={includeTrajectoryLog}
                onCheckedChange={handleTrajectoryLogChange}
                disabled={loading}
              />
              <span className="text-callout font-semibold">{formatMessage({ id: "agent.reportIssue.includeActivityHistory" })}</span>
            </label>
            {agent.machineId && (
              <label className="flex min-h-8 select-none items-center gap-2 has-[[data-disabled]]:text-foreground-disabled">
                <Checkbox
                  checked={includeSessionTranscript}
                  onCheckedChange={handleSessionTranscriptChange}
                  disabled={loading}
                />
                <span className="text-callout font-semibold">{formatMessage({ id: "agent.reportIssue.includeRuntimeTranscript" })}</span>
              </label>
            )}
            {includeSessionTranscript && agent.machineId && (
              <p className="ml-7 text-caption text-foreground-hint">
                {formatMessage({ id: "agent.reportIssue.runtimeTranscriptHint" })}
              </p>
            )}
            {canIncludeMachineLog && (
              <label className="flex min-h-8 select-none items-start gap-2 py-1.5 has-[[data-disabled]]:text-foreground-disabled">
                <Checkbox
                  checked={includeMachineLogTail}
                  onCheckedChange={handleMachineLogTailChange}
                  disabled={loading || !includeSessionTranscript}
                />
                <span className="text-callout font-semibold">
                  {formatMessage({ id: "agent.reportIssue.includeMachineLogTail" })}
                  <span className="block text-caption font-normal text-foreground-hint">
                    {formatMessage({ id: "agent.reportIssue.machineLogTailDisclosure" })}
                  </span>
                </span>
              </label>
            )}
          </div>
        </div>

        <Banner intent="warning" withIcon density="sm" className="mb-4">
          <p className="mb-2">
            {formatMessage(
              { id: "agent.reportIssue.sensitiveDataWarning" },
              { strong: (chunks) => <strong key="strong">{chunks}</strong> },
            )}
          </p>
          <label className="flex min-h-8 select-none items-center gap-2 has-[[data-disabled]]:text-foreground-disabled">
            <Checkbox
              checked={consented}
              onCheckedChange={handleConsentedChange}
              disabled={loading}
            />
            <span className="text-callout font-semibold">{formatMessage({ id: "agent.reportIssue.consent" })}</span>
          </label>
        </Banner>

        {error && (
          <Banner intent="warning" className="mb-4">
            {error}
          </Banner>
        )}

        <DialogCardFooter>
          <Button size="lg"
            variant="ghost"
            type="button"
            onClick={onClose}
            disabled={loading}
          >
            {formatMessage({ id: "common.confirm.cancel" })}
          </Button>
          <DialogCommit>
            {(inHead) => (
              <Button size={inHead ? "md" : "lg"}
                variant="primary"
                type="button"
                onClick={handleSubmit}
                disabled={loading || !consented}
              >
                {formatMessage({ id: loading ? "agent.reportIssue.submitting" : "agent.reportIssue.submit" })}
              </Button>
            )}
          </DialogCommit>
        </DialogCardFooter>
    </DialogCard>
  );
}
