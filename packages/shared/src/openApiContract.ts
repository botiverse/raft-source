import "zod-openapi";

import { z } from "zod";
import {
  createDocument,
  type ZodOpenApiOperationObject,
  type ZodOpenApiPathsObject,
  type ZodOpenApiResponsesObject,
} from "zod-openapi";

import { attachmentUploadContract } from "./attachmentUploadContract.js";

type ResponseDefinition = Readonly<{
  description: string;
  schema: z.ZodType;
}>;

type RegisteredOperation = Readonly<{
  method: "get" | "post" | "delete";
  path: string;
  operationId: string;
  summary: string;
  requestParams?: z.ZodObject;
  requestBody?: z.ZodType;
  responses: Readonly<Record<number, ResponseDefinition>>;
}>;

type RegisteredTag = Readonly<{
  name: string;
  description: string;
}>;

export type OpenApiContractModule = Readonly<{
  tags: readonly RegisteredTag[];
  operations: Readonly<Record<string, RegisteredOperation>>;
}>;

const defineContractModule = <const Module extends OpenApiContractModule>(contractModule: Module) =>
  contractModule;

/**
 * Organization-wide OpenAPI registry entry point.
 *
 * Feature contracts remain small modules. Adding another feature means adding
 * its module here; it must not create another generator, artifact layout, or
 * CI drift gate.
 */
export const openApiContractModules = {
  attachmentUploads: defineContractModule({
    tags: [{
      name: "Attachment uploads",
      description: "Create, verify, cancel, and inspect direct attachment upload sessions.",
    }],
    operations: attachmentUploadContract,
  }),
} as const;

type RegisteredOperationWithTags = Readonly<{
  definition: RegisteredOperation;
  tags: readonly string[];
}>;

const registeredModules = (): readonly OpenApiContractModule[] =>
  Object.values(openApiContractModules);

const registeredOperations = (): RegisteredOperationWithTags[] => registeredModules()
  .flatMap((contractModule) => Object.values(contractModule.operations).map((definition) => ({
    definition,
    tags: contractModule.tags.map(({ name }) => name),
  })));

const assertUnique = (seen: Set<string>, value: string, kind: string): void => {
  if (seen.has(value)) {
    throw new Error(`Duplicate OpenAPI ${kind}: ${value}`);
  }
  seen.add(value);
};

export const assertOpenApiRegistryIsValid = (
  contractModules: readonly OpenApiContractModule[],
): void => {
  const tagNames = new Set<string>();
  const operationIds = new Set<string>();
  const routes = new Set<string>();

  for (const contractModule of contractModules) {
    if (contractModule.tags.length === 0) {
      throw new Error("OpenAPI contract modules must declare at least one tag");
    }
    for (const tag of contractModule.tags) {
      assertUnique(tagNames, tag.name, "tag");
    }
    for (const definition of Object.values(contractModule.operations)) {
      assertUnique(operationIds, definition.operationId, "operationId");
      assertUnique(routes, `${definition.method.toUpperCase()} ${definition.path}`, "route");
    }
  }
};

const buildResponses = (
  responses: Readonly<Record<number, ResponseDefinition>>,
): ZodOpenApiResponsesObject => {
  const result: ZodOpenApiResponsesObject = {};
  for (const [status, response] of Object.entries(responses)) {
    if (!/^[1-5][0-9][0-9]$/.test(status)) {
      throw new Error(`Invalid OpenAPI response status: ${status}`);
    }
    const openApiStatus = status as `${1 | 2 | 3 | 4 | 5}${string}`;
    result[openApiStatus] = {
      description: response.description,
      content: {
        "application/json": { schema: response.schema },
      },
    };
  }
  return result;
};

const buildOperation = (
  definition: RegisteredOperation,
  tags: readonly string[],
): ZodOpenApiOperationObject => ({
  operationId: definition.operationId,
  summary: definition.summary,
  tags: [...tags],
  security: [{ bearerAuth: [], serverScope: [] }],
  ...(definition.requestParams
    ? { requestParams: { path: definition.requestParams } }
    : {}),
  ...(definition.requestBody
    ? {
        requestBody: {
          required: true,
          content: {
            "application/json": { schema: definition.requestBody },
          },
        },
      }
    : {}),
  responses: buildResponses(definition.responses),
});

export const buildOpenApiDocument = (): ReturnType<typeof createDocument> => {
  const paths: ZodOpenApiPathsObject = {};
  const contractModules = registeredModules();
  assertOpenApiRegistryIsValid(contractModules);

  for (const { definition, tags } of registeredOperations()) {
    const pathItem = paths[definition.path] ?? {};
    const operation = buildOperation(definition, tags);
    switch (definition.method) {
      case "get":
        pathItem.get = operation;
        break;
      case "post":
        pathItem.post = operation;
        break;
      case "delete":
        pathItem.delete = operation;
        break;
    }
    paths[definition.path] = pathItem;
  }

  return createDocument({
    openapi: "3.1.0",
    info: {
      title: "Raft API",
      version: "0.1.0",
      description: "Generated Raft API contract. The current P1 registry contains the additive, unmounted attachment-upload pilot.",
    },
    servers: [{
      url: "/",
      description: "The Raft server origin selected by the authenticated client.",
    }],
    tags: contractModules.flatMap(({ tags }) => tags),
    paths,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
        },
        serverScope: {
          type: "apiKey",
          in: "header",
          name: "X-Server-Id",
          description: "Server scope selected by the authenticated Raft member.",
        },
      },
    },
  });
};
