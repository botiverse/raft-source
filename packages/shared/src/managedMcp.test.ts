import assert from "node:assert/strict";
import { applyManagedMcpOAuthClientPolicy, formatManagedMcpRuntimeToolName, managedMcpOAuthClientPolicy } from "./managedMcp";

test("managed MCP runtime tool names are stable, bounded, and server-scoped", () => {
  const first = formatManagedMcpRuntimeToolName("12345678-aaaa-bbbb-cccc-123456789012", "issues/search");
  assert.equal(first, formatManagedMcpRuntimeToolName("12345678-aaaa-bbbb-cccc-123456789012", "issues/search"));
  assert.notEqual(first, formatManagedMcpRuntimeToolName("87654321-aaaa-bbbb-cccc-123456789012", "issues/search"));
  assert.notEqual(first, formatManagedMcpRuntimeToolName("12345678-dddd-eeee-ffff-123456789012", "issues/search"));
  assert.match(first, /^mcp_12345678_issues_search_[0-9a-f]{8}$/u);
  assert.ok(first.length < 80);
});

test("Google Workspace MCP endpoints get a fixed OAuth client policy with least-privilege scopes; others get none", () => {
  const scope = (name: string) => `https://www.googleapis.com/auth/${name}`;
  assert.deepEqual(managedMcpOAuthClientPolicy("https://docsmcp.googleapis.com/mcp/v1"), {
    provider: "google", apiService: "docsmcp.googleapis.com", productApiService: "docs.googleapis.com",
    tokenEndpointAuthMethod: "client_secret_post", requestOfflineAccess: true, scopes: [scope("documents")],
  });
  assert.equal(managedMcpOAuthClientPolicy("https://calendarmcp.googleapis.com/mcp/v1")?.productApiService, "calendar-json.googleapis.com");
  assert.equal(managedMcpOAuthClientPolicy("https://GmailMCP.googleapis.com/mcp/v1")?.apiService, "gmailmcp.googleapis.com");
  // Full Drive access, which every Docs/Sheets/Slides server lists as optional, is never requested.
  for (const service of ["docs", "sheets", "slides", "drive", "gmail", "calendar"]) {
    const policy = managedMcpOAuthClientPolicy(`https://${service}mcp.googleapis.com/mcp/v1`);
    assert.ok(policy && policy.scopes.length > 0, service);
    assert.ok(!policy.scopes.includes(scope("drive")) && !policy.scopes.includes("https://mail.google.com/"), service);
  }
  for (const service of ["docs", "sheets", "slides"]) {
    assert.ok(!managedMcpOAuthClientPolicy(`https://${service}mcp.googleapis.com/mcp/v1`)!.scopes.some((value) => value.includes("/auth/drive")), `${service} needs no Drive access`);
  }
  for (const other of ["https://mcp.notion.com/mcp", "https://docs.googleapis.com/v1", "https://docsmcp.googleapis.com.evil.test/mcp", "https://newthingmcp.googleapis.com/mcp/v1", "https://constructormcp.googleapis.com/mcp/v1", "https://tostringmcp.googleapis.com/mcp/v1", "https://__proto__mcp.googleapis.com/mcp/v1", "not a url"]) {
    assert.equal(managedMcpOAuthClientPolicy(other), null, other);
  }
  const policy = managedMcpOAuthClientPolicy("https://drivemcp.googleapis.com/mcp/v1");
  assert.deepEqual(
    applyManagedMcpOAuthClientPolicy(policy, { clientId: "id", clientSecret: "s", tokenEndpointAuthMethod: "none", scope: "https://www.googleapis.com/auth/drive", requestOfflineAccess: false }),
    { clientId: "id", clientSecret: "s", tokenEndpointAuthMethod: "client_secret_post", scope: `${scope("drive.readonly")} ${scope("drive.file")}`, requestOfflineAccess: true },
  );
  assert.equal(applyManagedMcpOAuthClientPolicy(policy, null), null, "removal is left for the caller to refuse");
  assert.equal(applyManagedMcpOAuthClientPolicy(policy, undefined), undefined);
});

test("each Google MCP policy authorizes every tool of its server", () => {
  // Google's per-tool reference, "Requires one of the following OAuth scopes" (2026-11-02):
  // developers.google.com/workspace/<product>/api/reference/mcp (Calendar: .../api/v3/reference/mcp).
  const tools: Record<string, Record<string, string[]>> = {
    docs: {
      read_doc: ["drive.readonly", "documents.readonly", "drive", "drive.file", "documents"],
      update_doc: ["drive", "drive.file", "documents"],
    },
    sheets: {
      get_spreadsheet: ["drive.readonly", "spreadsheets.readonly", "drive", "drive.file", "spreadsheets"],
      get_values: ["drive.readonly", "spreadsheets.readonly", "drive", "drive.file", "spreadsheets"],
      update_formulas: ["drive", "drive.file", "spreadsheets"],
      update_spreadsheet: ["drive", "drive.file", "spreadsheets"],
      update_values: ["drive", "drive.file", "spreadsheets"],
      insert_dimension: ["drive", "spreadsheets"],
    },
    slides: {
      read_presentation: ["drive.readonly", "presentations.readonly", "drive", "drive.file", "presentations"],
      read_slide_page: ["drive.readonly", "presentations.readonly", "drive", "drive.file", "presentations"],
      read_slide_page_thumbnail: ["drive.readonly", "presentations.readonly", "drive", "drive.file", "presentations"],
      update_presentation: ["drive", "drive.file", "presentations"],
    },
    drive: {
      copy_file: ["drive", "drive.appdata", "drive.file"],
      create_file: ["drive", "drive.appdata", "drive.file"],
      download_file_content: ["drive", "drive.file", "drive.readonly", "drive.metadata.readonly"],
      get_file_metadata: ["drive", "drive.file", "drive.readonly", "drive.metadata.readonly"],
      get_file_permissions: ["drive", "drive.file", "drive.readonly", "drive.metadata.readonly"],
      list_recent_files: ["drive", "drive.file", "drive.readonly", "drive.metadata.readonly"],
      read_file_content: ["drive", "drive.file", "drive.readonly", "drive.metadata.readonly"],
      search_files: ["drive", "drive.file", "drive.readonly", "drive.metadata.readonly"],
    },
    gmail: {
      create_draft: ["mail.google.com", "gmail.modify", "gmail.compose"],
      get_message: ["mail.google.com", "gmail.modify", "gmail.readonly", "gmail.metadata"],
      get_thread: ["mail.google.com", "gmail.modify", "gmail.readonly", "gmail.metadata"],
      list_drafts: ["mail.google.com", "gmail.modify", "gmail.compose", "gmail.readonly"],
      list_labels: ["mail.google.com", "gmail.modify", "gmail.readonly", "gmail.labels", "gmail.metadata"],
      search_threads: ["mail.google.com", "gmail.modify", "gmail.readonly"],
      label_message: ["mail.google.com", "gmail.modify"],
      label_thread: ["mail.google.com", "gmail.modify"],
      unlabel_message: ["mail.google.com", "gmail.modify"],
      unlabel_thread: ["mail.google.com", "gmail.modify"],
    },
    calendar: {
      create_event: ["calendar", "calendar.events"],
      delete_event: ["calendar", "calendar.events"],
      update_event: ["calendar", "calendar.events"],
      respond_to_event: ["calendar", "calendar.events"],
      get_event: ["calendar", "calendar.events", "calendar.events.readonly", "calendar.readonly"],
      list_events: ["calendar", "calendar.events", "calendar.events.readonly", "calendar.readonly"],
      search_events: ["calendar", "calendar.events", "calendar.events.readonly", "calendar.readonly"],
      list_calendars: ["calendar", "calendar.readonly", "calendar.calendarlist", "calendar.calendarlist.readonly"],
      suggest_time: ["calendar", "calendar.readonly", "calendar.events", "calendar.events.freebusy", "calendar.freebusy"],
    },
  };
  const full = (name: string) => (name === "mail.google.com" ? "https://mail.google.com/" : `https://www.googleapis.com/auth/${name}`);
  for (const [service, byTool] of Object.entries(tools)) {
    const granted = managedMcpOAuthClientPolicy(`https://${service}mcp.googleapis.com/mcp/v1`)!.scopes;
    for (const [tool, accepted] of Object.entries(byTool)) {
      assert.ok(accepted.map(full).some((scope) => granted.includes(scope)), `${service}.${tool} is authorized by ${granted.join(" ")}`);
    }
    // No scope beyond what some tool needs.
    for (const scope of granted) {
      assert.ok(Object.values(byTool).some((accepted) => accepted.map(full).includes(scope)), `${service} requests unused ${scope}`);
    }
  }
});
