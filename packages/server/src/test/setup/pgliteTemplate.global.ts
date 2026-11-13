import type { TestProject } from "vitest/node";
import { ensureTemplate, TEMPLATE_PROVIDE_KEY } from "./pgliteTemplate";

// Vitest globalSetup: one migrated PGlite template file per run (cached across
// runs by migration/PGlite key), handed to workers via provide/inject.
export default async function setup({ provide }: TestProject) {
  const templatePath = await ensureTemplate();
  if (templatePath) provide(TEMPLATE_PROVIDE_KEY, templatePath);
}
