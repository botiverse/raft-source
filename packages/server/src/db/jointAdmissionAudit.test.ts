import { test } from "vitest";
import { jointAdmissionAuditScenario } from "../test/jointAdmissionAuditScenario";

test("admission audit survives member and projection removal without losing entity integrity", async () => {
  await jointAdmissionAuditScenario();
}, 30_000);
