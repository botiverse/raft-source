import assert from "node:assert/strict";
import { test } from "vitest";

import type { ExternalAttachmentAuthority } from "./externalAttachmentProviderAdapter.js";
import {
  createSlackInboundAttachmentAdapter,
  type SlackInboundAttachmentTransport,
} from "./slackInboundAttachmentAdapter.js";

const AUTHORITY: ExternalAttachmentAuthority = {
  provider: "slack",
  appRegistrationId: "registration-1",
  installId: "install-1",
  workspaceId: "workspace-1",
  providerAuthorityId: "workspace-1",
  providerConversationId: "conversation-1",
  connectionEpoch: 2,
  bindingId: "binding-1",
  bindingEpoch: 3,
};

function transport(overrides: Partial<SlackInboundAttachmentTransport> = {}): SlackInboundAttachmentTransport {
  return {
    async inspect({ providerFileId }) {
      return {
        id: providerFileId,
        user: "U_OWNER",
        name: "design.pdf",
        mimetype: "application/pdf",
        size: 6,
        timestamp: 1_788_541_200,
        urlPrivateDownload: "https://files.slack.com/files-pri/T1-F1/design.pdf",
      };
    },
    async *download() {
      yield Buffer.from("abc");
      yield Buffer.from("def");
    },
    ...overrides,
  };
}

test("Slack file inspection exposes only bounded metadata and an adapter-private download handle", async () => {
  const adapter = createSlackInboundAttachmentAdapter(transport());
  const controller = new AbortController();
  const inspected = await adapter.inspectInboundAsset({
    authority: AUTHORITY,
    providerFileId: "F1",
    signal: controller.signal,
  });
  assert.deepEqual(inspected.metadata, {
    providerFileId: "F1",
    sourceExternalActorId: "U_OWNER",
    filename: "design.pdf",
    declaredSizeBytes: 6,
    mimeType: "application/pdf",
    providerCreatedAt: new Date(1_788_541_200_000),
  });
  const chunks: Uint8Array[] = [];
  for await (const chunk of adapter.downloadInboundAsset({
    authority: AUTHORITY,
    handle: inspected.downloadHandle,
    maximumBytes: 100,
    signal: controller.signal,
  })) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString("utf8"), "abcdef");
  assert.doesNotMatch(JSON.stringify(inspected.metadata), /files\.slack\.com|files-pri/);
});

test("Slack file identity and private-host mismatches fail deterministically before download", async () => {
  const wrongIdentity = createSlackInboundAttachmentAdapter(transport({
    async inspect() {
      return {
        id: "F_OTHER",
        user: "U_OWNER",
        name: "design.pdf",
        mimetype: "application/pdf",
        size: 6,
        timestamp: null,
        urlPrivateDownload: "https://files.slack.com/files-pri/T1-F1/design.pdf",
      };
    },
  }));
  await assert.rejects(wrongIdentity.inspectInboundAsset({
    authority: AUTHORITY,
    providerFileId: "F1",
    signal: new AbortController().signal,
  }), (error: unknown) => wrongIdentity.classifyFailure(error).reason === "provider_file_identity_mismatch");

  const wrongHost = createSlackInboundAttachmentAdapter(transport({
    async inspect({ providerFileId }) {
      return {
        id: providerFileId,
        user: "U_OWNER",
        name: "design.pdf",
        mimetype: "application/pdf",
        size: 6,
        timestamp: null,
        urlPrivateDownload: "https://attacker.example.test/files-pri/T1-F1/design.pdf",
      };
    },
  }));
  await assert.rejects(wrongHost.inspectInboundAsset({
    authority: AUTHORITY,
    providerFileId: "F1",
    signal: new AbortController().signal,
  }), (error: unknown) => wrongHost.classifyFailure(error).reason === "provider_file_download_locator_invalid");
});

test("Slack file stream enforces declared and plan byte ceilings", async () => {
  const adapter = createSlackInboundAttachmentAdapter(transport());
  const inspected = await adapter.inspectInboundAsset({
    authority: AUTHORITY,
    providerFileId: "F1",
    signal: new AbortController().signal,
  });
  await assert.rejects(async () => {
    for await (const _chunk of adapter.downloadInboundAsset({
      authority: AUTHORITY,
      handle: inspected.downloadHandle,
      maximumBytes: 5,
      signal: new AbortController().signal,
    })) {
      // consume
    }
  }, (error: unknown) => adapter.classifyFailure(error).reason === "provider_file_size_exceeds_plan");

  const oversized = createSlackInboundAttachmentAdapter(transport({
    async *download() {
      yield Buffer.from("abcdefg");
    },
  }));
  const oversizedHandle = await oversized.inspectInboundAsset({
    authority: AUTHORITY,
    providerFileId: "F1",
    signal: new AbortController().signal,
  });
  await assert.rejects(async () => {
    for await (const _chunk of oversized.downloadInboundAsset({
      authority: AUTHORITY,
      handle: oversizedHandle.downloadHandle,
      maximumBytes: 100,
      signal: new AbortController().signal,
    })) {
      // consume
    }
  }, (error: unknown) => oversized.classifyFailure(error).reason === "provider_file_stream_exceeded_bound");
});
