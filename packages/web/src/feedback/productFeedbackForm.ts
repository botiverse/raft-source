// The POST /api/product-feedback form every web submission starts from: the
// in-app feedback workspace, an agent's Report Issue ticket and a
// `feedback:submit` action card send the same fields, so the server derives
// the same client facts for all three (the api client adds X-Server-Id).
// No imports: the startup bundle uses it (scripts/check-feedback-workspace-split.ts).

export function productFeedbackForm(input: {
  type: "idea" | "problem";
  message: string;
  submissionId: string;
  /** Client facts for the server's `metadata` field; omitted when null. */
  metadata?: Record<string, string> | null;
}): FormData {
  const form = new FormData();
  form.set("type", input.type);
  form.set("message", input.message);
  if (input.metadata) form.set("metadata", JSON.stringify(input.metadata));
  form.set("submission_id", input.submissionId);
  form.set("may_contact", "false");
  return form;
}
