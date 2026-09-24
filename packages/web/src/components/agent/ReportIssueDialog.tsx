import { useMemo, useState } from "react";
import { Bug, CheckCircle } from "lucide-react";
import { useIntl } from "react-intl";
import type { IntlShape } from "react-intl";
import DialogCard from "../ui/DialogCard";
import Banner from "../ui/Banner";
import Checkbox from "../ui/Checkbox";
import SectionEyebrow from "../ui/SectionEyebrow";
import FormField from "../ui/FormField";
import api from "../../api/client";
import { useAuthStore } from "../../store/authStore";
import { useServerStore } from "../../store/serverStore";
import { useAgentStore } from "../../store/agentStore";
import type { Agent } from "../../store/agentStore";
import { useMachineStore } from "../../store/machineStore";
import { buildFeedbackExportBundle } from "../../utils/feedbackExportBundle";
import type { FeedbackExportBundleV2 } from "../../utils/feedbackExportBundle";
import { detectBrowserTimezone } from "../../utils/timeFormatting";
import { WEB_APP_VERSION } from "../../utils/webAppVersion";

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

type SubmittedReport = {
  reportId: string;
  artifactId?: string;
  serverId: string;
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

function buildExportFilename(agent: Agent) {
  const safeName = (agent.displayName || agent.name)
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "agent";
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `slock-feedback-export-${safeName}-${timestamp}.json`;
}

function browserLocaleHint(): string | null {
  return navigator.languages?.[0] || navigator.language || null;
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
  const { formatMessage } = useIntl();
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
  const [consented, setConsented] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [submittedReport, setSubmittedReport] = useState<SubmittedReport | null>(null);
  const [reportRefCopied, setReportRefCopied] = useState(false);

  const handleSubmit = async () => {
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

        bundle = buildFeedbackExportBundle({
          appVersion: FEEDBACK_APP_VERSION,
          daemonVersion: machine?.daemonVersion ?? null,
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
            machineName: machine?.name ?? null,
            machineStatus: machine?.status ?? null,
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

      await api.post(
        `/servers/${server.id}/feedback/${report.id}/receipt`,
        { locale: browserLocaleHint() }
      ).catch((err) => {
        console.warn("[ReportIssueDialog] Failed to send feedback receipt email", describeApiFailure(err, formatMessage));
      });

      const transcriptAttachmentRequested = includeSessionTranscript && Boolean(agent.machineId);
      if (transcriptAttachmentRequested && agent.machineId) {
        void api.post(
          `/servers/${server.id}/machines/${agent.machineId}/agents/${agent.id}/feedback/${report.id}/transcript`,
          { reportGeneratedAt: bundle.generatedAt }
        ).catch((err) => {
          console.warn("[ReportIssueDialog] Failed to queue runtime transcript attachment", describeApiFailure(err, formatMessage));
        });
      }

      setSubmittedReport({
        reportId: report.id,
        artifactId: report.artifactId,
        serverId: server.id,
        issueDescription: description.trim() || undefined,
        transcriptAttachmentRequested,
      });
      setSubmitted(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : formatMessage({ id: "agent.reportIssue.submitFailed" }));
    } finally {
      setLoading(false);
    }
  };

  const handleCopyReportReference = async () => {
    if (!submittedReport) return;
    const lines = [
      `reportId: ${submittedReport.reportId}`,
      `serverId: ${submittedReport.serverId}`,
      submittedReport.artifactId ? `artifactId: ${submittedReport.artifactId}` : null,
      submittedReport.issueDescription ? `issueDescription:\n${submittedReport.issueDescription}` : null,
    ].filter(Boolean);
    await navigator.clipboard.writeText(lines.join("\n"));
    setReportRefCopied(true);
  };

  if (submitted) {
    return (
      <DialogCard title={formatMessage({ id: "agent.reportIssue.submittedTitle" })} onClose={onClose} maxWidthClass="max-w-sm">
          <div className="flex flex-col items-center gap-4 py-4">
            <div className="flex size-12 items-center justify-center border-2 border-black bg-brutal-lime">
              <CheckCircle size={24} />
            </div>
            <div className="text-center">
              <p className="font-bold text-black">{formatMessage({ id: "agent.reportIssue.uploaded" })}</p>
              <p className="mt-1 text-sm text-black/60">
                {formatMessage({ id: "agent.reportIssue.uploadedDescription" })}
              </p>
            </div>
            {submittedReport && (
              <div className="w-full border-2 border-black bg-white p-3 text-left">
                <SectionEyebrow as="div" className="mb-1">{formatMessage({ id: "agent.reportIssue.reportReference" })}</SectionEyebrow>
                <dl className="space-y-1 text-xs">
                  <div>
                    <dt className="font-bold uppercase text-black/60">{formatMessage({ id: "agent.reportIssue.reportId" })}</dt>
                    <dd className="break-all font-mono text-black">{submittedReport.reportId}</dd>
                  </div>
                  {submittedReport.artifactId && (
                    <div>
                      <dt className="font-bold uppercase text-black/60">{formatMessage({ id: "agent.reportIssue.artifactId" })}</dt>
                      <dd className="break-all font-mono text-black">{submittedReport.artifactId}</dd>
                    </div>
                  )}
                  <div>
                    <dt className="font-bold uppercase text-black/60">{formatMessage({ id: "agent.reportIssue.serverId" })}</dt>
                    <dd className="break-all font-mono text-black">{submittedReport.serverId}</dd>
                  </div>
                  {submittedReport.transcriptAttachmentRequested && (
                    <div>
                      <dt className="font-bold uppercase text-black/60">{formatMessage({ id: "agent.reportIssue.runtimeTranscript" })}</dt>
                      <dd className="text-black">{formatMessage({ id: "agent.reportIssue.runtimeTranscriptQueued" })}</dd>
                    </div>
                  )}
                </dl>
                <button
                  type="button"
                  onClick={handleCopyReportReference}
                  className="btn-brutal-sm mt-3 bg-white px-3 py-1 text-xs"
                >
                  {formatMessage({ id: reportRefCopied ? "agent.reportIssue.copied" : "agent.reportIssue.copyReference" })}
                </button>
              </div>
            )}
          </div>
          <div className="flex justify-end">
            <button type="button" onClick={onClose} className="btn-brutal bg-brutal-lime px-4 py-2 text-sm">
              {formatMessage({ id: "agent.reportIssue.done" })}
            </button>
          </div>
      </DialogCard>
    );
  }

  return (
    <DialogCard
      title={(
        <span className="flex items-center gap-2">
          <Bug size={18} />
          {formatMessage({ id: "agent.reportIssue.title" })}
        </span>
      )}
      onClose={onClose}
      maxWidthClass="max-w-sm"
    >

        <div className="mb-4 border-2 border-black bg-white px-3 py-2">
          <SectionEyebrow>{formatMessage({ id: "agent.reportIssue.agentLabel" })}</SectionEyebrow>
          <p className="mt-0.5 font-bold text-black">{agent.displayName || agent.name}</p>
        </div>

        <FormField label={formatMessage({ id: "agent.reportIssue.describeLabel" })} optional className="mb-4">
          <textarea
            className="input-brutal w-full resize-none rounded-none p-2 text-sm"
            rows={3}
            placeholder={formatMessage({ id: "agent.reportIssue.describePlaceholder" })}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            disabled={loading}
          />
        </FormField>

        <div className="mb-4">
          <SectionEyebrow as="div" className="mb-1">{formatMessage({ id: "agent.reportIssue.includeLabel" })}</SectionEyebrow>
          <p className="mb-2 text-xs text-black/60">
            {formatMessage({ id: "agent.reportIssue.defaultIncludedDisclosure" })}
          </p>
          <div className="flex flex-col gap-1.5">
            <label className="flex select-none items-center gap-2">
              <Checkbox
                checked={includeRecentMessages}
                onChange={(e) => setIncludeRecentMessages(e.target.checked)}
                disabled={loading}
              />
              <span className="text-sm">{formatMessage({ id: "agent.reportIssue.includeRecentMessages" })}</span>
            </label>
            <label className="flex select-none items-center gap-2">
              <Checkbox
                checked={includeActivityLog}
                onChange={(e) => setIncludeActivityLog(e.target.checked)}
                disabled={loading}
              />
              <span className="text-sm">{formatMessage({ id: "agent.reportIssue.includeLiveActivity" })}</span>
            </label>
            <label className="flex select-none items-center gap-2">
              <Checkbox
                checked={includeTrajectoryLog}
                onChange={(e) => setIncludeTrajectoryLog(e.target.checked)}
                disabled={loading}
              />
              <span className="text-sm">{formatMessage({ id: "agent.reportIssue.includeActivityHistory" })}</span>
            </label>
            <label className="flex select-none items-center gap-2">
              <Checkbox
                checked={includeSessionTranscript}
                onChange={(e) => setIncludeSessionTranscript(e.target.checked)}
                disabled={loading || !agent.machineId}
              />
              <span className="text-sm">{formatMessage({ id: "agent.reportIssue.includeRuntimeTranscript" })}</span>
            </label>
          </div>
          {!agent.machineId && (
            <p className="mt-1 text-xs text-black/60">
              {formatMessage({ id: "agent.reportIssue.runtimeTranscriptUnavailable" })}
            </p>
          )}
        </div>

        <Banner intent="warning" withIcon density="sm" className="mb-5">
          <p className="mb-2 text-black/80">
            {formatMessage(
              { id: "agent.reportIssue.sensitiveDataWarning" },
              { strong: (chunks) => <strong key="strong">{chunks}</strong> },
            )}
          </p>
          <label className="flex select-none items-center gap-2">
            <Checkbox
              checked={consented}
              onChange={(e) => setConsented(e.target.checked)}
              disabled={loading}
            />
            <span className="text-xs font-bold">{formatMessage({ id: "agent.reportIssue.consent" })}</span>
          </label>
        </Banner>

        {error && (
          <Banner intent="warning" className="mb-4 font-bold">
            {error}
          </Banner>
        )}

        <div className="flex justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            disabled={loading}
            className="btn-brutal bg-white px-4 py-2 text-sm disabled:opacity-50"
          >
            {formatMessage({ id: "common.confirm.cancel" })}
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={loading || !consented}
            className="btn-brutal bg-brutal-pink px-4 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50"
          >
            {formatMessage({ id: loading ? "agent.reportIssue.submitting" : "agent.reportIssue.title" })}
          </button>
        </div>
    </DialogCard>
  );
}
