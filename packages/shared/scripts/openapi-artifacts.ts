import { Buffer } from "node:buffer";

import openapiTS, { astToString, COMMENT_HEADER } from "openapi-typescript";

import { buildOpenApiDocument } from "../src/openApiContract.js";

export interface OpenApiArtifacts {
  openApiJson: string;
  webTypes: string;
}

export const renderOpenApiArtifacts = async (): Promise<OpenApiArtifacts> => {
  const openApiJson = `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`;
  const ast = await openapiTS(Buffer.from(openApiJson), {
    alphabetize: true,
    exportType: true,
  });
  const renderedTypes = astToString(ast);
  const webTypes = renderedTypes.startsWith(COMMENT_HEADER)
    ? renderedTypes
    : `${COMMENT_HEADER}${renderedTypes}`;

  return { openApiJson, webTypes };
};
