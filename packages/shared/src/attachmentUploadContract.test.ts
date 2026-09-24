import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { z } from "zod";

import {
  ATTACHMENT_UPLOAD_MAX_SIZE_BYTES,
  attachmentUploadContract,
  createAttachmentUploadSessionRequestSchema,
  createAttachmentUploadSessionResponseSchema,
  attachmentUploadSessionSchema,
  completeAttachmentUploadSessionResponseSchema,
  getAttachmentUploadResponseSchema,
} from "./attachmentUploadContract.js";
import {
  assertOpenApiRegistryIsValid,
  buildOpenApiDocument,
  openApiContractModules,
  type OpenApiContractModule,
} from "./openApiContract.js";

const fixtureSchema = z.strictObject({
  operation: z.enum(["create", "complete", "cancel", "status"]),
  status: z.int().positive(),
  body: z.record(z.string(), z.unknown()),
});

const fixtureFileSchema = z.strictObject({
  fixtures: z.array(fixtureSchema),
});

const readFixtureFile = (filename: string) => {
  const source = readFileSync(new URL(`./fixtures/${filename}`, import.meta.url), "utf8");
  return {
    source,
    data: fixtureFileSchema.parse(JSON.parse(source)),
  };
};

test("central OpenAPI registry keeps the attachment module additive, unmounted, and explicit by status", () => {
  assert.deepEqual(Object.keys(openApiContractModules), ["attachmentUploads"]);
  assert.equal(openApiContractModules.attachmentUploads.operations, attachmentUploadContract);
  assert.deepEqual(Object.keys(attachmentUploadContract), ["capabilities", "create", "complete", "cancel", "status"]);
  const operations = Object.values(attachmentUploadContract);
  assert.equal(new Set(operations.map(({ operationId }) => operationId)).size, 5, "operation ids are unique");
  for (const operation of operations) {
    const placeholders = [...operation.path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
    const pathParams = "requestParams" in operation
      ? Object.keys(operation.requestParams.shape)
      : [];
    assert.deepEqual(pathParams, placeholders, `${operation.operationId} path params match placeholders`);
    const statuses = Object.keys(operation.responses).map(Number);
    assert.ok(statuses.some((status) => status < 400), `${operation.operationId} declares success`);
    if (operation.operationId !== "getAttachmentUploadCapabilities") {
      assert.ok(statuses.some((status) => status >= 400), `${operation.operationId} declares operation-local errors`);
    }
  }
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(attachmentUploadContract).map(([key, operation]) => [
        key,
        Object.keys(operation.responses).map(Number),
      ]),
    ),
    {
      capabilities: [200],
      create: [201, 400, 403, 409, 413, 429],
      complete: [200, 403, 404, 409, 410, 422],
      cancel: [200, 403, 404, 409],
      status: [200, 403, 404],
    },
  );

  const document = buildOpenApiDocument();
  for (const pathItem of Object.values(document.paths ?? {})) {
    for (const method of ["get", "post", "delete"] as const) {
      const operation = pathItem[method];
      if (!operation) continue;
      assert.deepEqual(operation.security, [{ bearerAuth: [], serverScope: [] }]);
      assert.ok(operation.responses, `${operation.operationId} declares responses`);
      assert.equal("default" in operation.responses, false, `${operation.operationId} must not use a default response`);
    }
  }
});

test("central OpenAPI registry rejects collisions before document generation", () => {
  const module = openApiContractModules.attachmentUploads;
  const [create, complete] = Object.values(attachmentUploadContract);
  const assertInvalid = (contractModules: readonly OpenApiContractModule[], expected: RegExp) => {
    assert.throws(() => assertOpenApiRegistryIsValid(contractModules), expected);
  };

  assertInvalid([{ ...module, tags: [...module.tags, module.tags[0]] }], /Duplicate OpenAPI tag/);
  assertInvalid(
    [{ ...module, operations: { create, duplicate: { ...complete, operationId: create.operationId } } }],
    /Duplicate OpenAPI operationId/,
  );
  assertInvalid(
    [{ ...module, operations: { create, duplicate: { ...complete, method: create.method, path: create.path } } }],
    /Duplicate OpenAPI route/,
  );
  assertInvalid([{ ...module, tags: [] }], /must declare at least one tag/);
});

test("shared positive fixtures prove every explicit status-specific error mapping", () => {
  const { source, data } = readFixtureFile("attachmentUploadContract.valid.json");
  assert.doesNotMatch(source, /https?:|authorization|x-amz-|presigned|\"url\"/i);

  const expectedErrorPairs = Object.entries(attachmentUploadContract).flatMap(([operation, definition]) =>
    Object.keys(definition.responses)
      .map(Number)
      .filter((status) => status >= 400)
      .map((status) => `${operation}:${status}`),
  );
  const fixturePairs = data.fixtures.map(({ operation, status }) => `${operation}:${status}`);
  assert.deepEqual(fixturePairs.sort(), expectedErrorPairs.sort());

  for (const fixture of data.fixtures) {
    const schema = getAttachmentUploadResponseSchema(fixture.operation, fixture.status);
    assert.ok(schema, `${fixture.operation}:${fixture.status} is declared`);
    assert.deepEqual(schema.parse(fixture.body), fixture.body);
  }
});

test("shared negative fixtures reject status, code, and retry-semantics drift", () => {
  const { source, data } = readFixtureFile("attachmentUploadContract.invalid.json");
  assert.doesNotMatch(source, /https?:|authorization|x-amz-|presigned|\"url\"/i);

  for (const fixture of data.fixtures) {
    const schema = getAttachmentUploadResponseSchema(fixture.operation, fixture.status);
    assert.equal(schema?.safeParse(fixture.body).success ?? false, false, `${fixture.operation}:${fixture.status} must reject invalid fixture`);
  }
});

test("wire schemas are strict, bounded, and keep the presigned URL ephemeral", () => {
  const request = {
    channelId: "11111111-1111-4111-8111-111111111111",
    filename: "recording.mp4",
    mimeType: "video/mp4",
    sizeBytes: ATTACHMENT_UPLOAD_MAX_SIZE_BYTES,
    clientRequestId: "22222222-2222-4222-8222-222222222222",
  };
  assert.deepEqual(createAttachmentUploadSessionRequestSchema.parse(request), request);
  assert.throws(
    () => createAttachmentUploadSessionRequestSchema.parse({ ...request, sizeBytes: ATTACHMENT_UPLOAD_MAX_SIZE_BYTES + 1 }),
    { name: "ZodError" },
  );
  assert.throws(
    () => createAttachmentUploadSessionRequestSchema.parse({ ...request, unexpected: true }),
    { name: "ZodError" },
  );

  const response = {
    uploadId: "33333333-3333-4333-8333-333333333333",
    attachmentId: "44444444-4444-4444-8444-444444444444",
    state: "pending",
    expiresAt: "2026-07-25T06:00:00.000Z",
    upload: {
      method: "PUT",
      url: "https://object-upload.invalid/single-use-value",
      headers: { "Content-Type": "video/mp4", "If-None-Match": "*" },
    },
  };
  assert.deepEqual(createAttachmentUploadSessionResponseSchema.parse(response), response);

  const session = {
    uploadId: response.uploadId,
    state: "verifying",
    expiresAt: response.expiresAt,
    attachment: null,
    terminalReason: null,
  };
  assert.deepEqual(attachmentUploadSessionSchema.parse(session), session);
  assert.throws(
    () => attachmentUploadSessionSchema.parse({ ...session, attachment: undefined }),
    { name: "ZodError" },
  );

  const completed = {
    uploadId: response.uploadId,
    state: "completed",
    attachment: {
      id: response.attachmentId,
      filename: request.filename,
      mimeType: request.mimeType,
      sizeBytes: request.sizeBytes,
      thumbnailUrl: null,
    },
  };
  assert.deepEqual(completeAttachmentUploadSessionResponseSchema.parse(completed), completed);
});
