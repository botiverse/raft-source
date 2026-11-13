import api from "../api/client";
import { isElectronDesktopShell } from "../utils/desktopShell";
import { getDesktopBridge } from "../utils/desktopBridge";
import { productFeedbackForm } from "./productFeedbackForm";

// Kept apart from handsFeedbackTransport.ts on purpose: that module imports
// @botiverse/hands-feedback-react, and the agent Report Issue dialog is in the
// startup bundle, which must not pull the feedback workspace in
// (scripts/check-feedback-workspace-split.ts).

// When feedback is submitted from the desktop shell, attribute it via the server's
// structured feedback `metadata` channel (routes/productFeedback.ts parses a JSON
// `metadata` field → normalizeProductFeedbackMetadata), so triage can tell a report
// came from Raft Desktop (requested by @WAWQAQ, #kabi-desktop task #82). This does NOT
// touch the user's message (which is capped at 10,000 chars server- and client-side),
// and needs no new server client kind: the default "web" kind carries client_version /
// os_version, so we surface the desktop identity in client_version="Raft Desktop <ver>".
// Returns null off the desktop shell (no desktop fields; the agent issue ticket
// below still sends `locale`). Exported for tests.
export async function desktopFeedbackMetadata(): Promise<Record<string, string> | null> {
  if (!isElectronDesktopShell()) return null;
  const raftDesktop = getDesktopBridge();
  let version = "";
  try {
    version = (await raftDesktop?.getAppVersion?.()) ?? "";
  } catch {
    // A missing/older bridge (no getAppVersion) still marks the report as desktop.
  }
  const metadata: Record<string, string> = {
    client_version: version ? `Raft Desktop ${version}` : "Raft Desktop",
  };
  if (raftDesktop?.platform) metadata.os_version = raftDesktop.platform;
  return metadata;
}

// Files the Hands ticket for an agent Report Issue. The debug bundle is
// already stored by the trace upload worker; the ticket carries only the
// user's description plus `feedback_report_id`, which developer tooling uses to
// find that bundle. Replies then arrive in the ordinary feedback inbox.
// `locale` is the active Raft UI locale, sent as `metadata.locale` from every
// client (Web/PWA and Desktop) so triage knows the reporter's language; the
// message itself is never translated or altered.
// Errors propagate as-is: the dialog treats any failure as "not filed" and
// offers a retry with the same submission id.
export async function createAgentIssueTicket(input: {
  message: string;
  feedbackReportId: string;
  submissionId: string;
  locale: string;
}): Promise<{ id: string }> {
  const desktopMetadata = await desktopFeedbackMetadata();
  const form = productFeedbackForm({
    type: "problem",
    message: input.message,
    submissionId: input.submissionId,
    metadata: { ...desktopMetadata, locale: input.locale },
  });
  form.set("feedback_report_id", input.feedbackReportId);
  const { data } = await api.post<{ id: string }>("/product-feedback", form);
  return { id: data.id };
}
