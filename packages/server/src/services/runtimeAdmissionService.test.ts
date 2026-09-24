import assert from "node:assert/strict";
import { test } from "vitest";
import { RUNTIMES } from "@botiverse/raft-shared";
import {
  projectExistingAgentRuntimeOptions,
  projectNewAgentRuntimeOptions,
  projectSetupRuntimeOptions,
} from "./runtimeAdmissionService.js";
import { KIMI_SDK_FORM_DEFINITION_REF } from "./runtimeFormDefinitionService.js";

test("new-agent runtime options keep capability separate from admission", () => {
  const disabled = projectNewAgentRuntimeOptions(["codex", "grok"], {
    grokRuntimeEnabled: false,
  });
  assert.equal(disabled.some((option) => option.runtimeId === "grok"), false);
  assert.deepEqual(disabled.find((option) => option.runtimeId === "codex"), {
    runtimeId: "codex",
    capabilityStatus: "available",
    admissionStatus: "available_for_new",
    admissionReason: null,
    current: false,
    availableForNew: true,
    manageableForCurrentAgent: false,
    canSelectInThisContext: true,
  });

  const enabled = projectNewAgentRuntimeOptions(["codex", "grok"], {
    grokRuntimeEnabled: true,
  });
  assert.deepEqual(enabled.find((option) => option.runtimeId === "grok"), {
    runtimeId: "grok",
    capabilityStatus: "available",
    admissionStatus: "available_for_new",
    admissionReason: null,
    current: false,
    availableForNew: true,
    manageableForCurrentAgent: false,
    canSelectInThisContext: true,
  });
});

test("new-agent runtime options distinguish local install from computer update", () => {
  const options = projectNewAgentRuntimeOptions([], { grokRuntimeEnabled: false });
  assert.equal(options.find((option) => option.runtimeId === "claude")?.capabilityStatus, "not_installed");
  assert.equal(options.find((option) => option.runtimeId === "builtin")?.capabilityStatus, "update_required");
  assert.equal(options.find((option) => option.runtimeId === "claude")?.canSelectInThisContext, false);
  assert.equal(options.find((option) => option.runtimeId === "builtin")?.canSelectInThisContext, false);
});

test("Kimi runtime options advertise the versioned schema form for create and edit", () => {
  const createOption = projectNewAgentRuntimeOptions(["kimi-sdk"], {
    grokRuntimeEnabled: false,
  }).find((option) => option.runtimeId === "kimi-sdk");
  assert.deepEqual(createOption?.formDefinitionRef, KIMI_SDK_FORM_DEFINITION_REF);

  const editOption = projectExistingAgentRuntimeOptions(["kimi-sdk"], "kimi-sdk", {
    grokRuntimeEnabled: false,
  }).find((option) => option.runtimeId === "kimi-sdk");
  assert.deepEqual(editOption?.formDefinitionRef, KIMI_SDK_FORM_DEFINITION_REF);
});

test("current-only Kimi keeps the registered schema ref for resume/edit", () => {
  const kimiRuntime = RUNTIMES.find((runtime) => runtime.id === "kimi-sdk");
  assert.ok(kimiRuntime);
  const wasDeprecated = kimiRuntime.deprecated;
  kimiRuntime.deprecated = true;
  try {
    const currentOnlyOption = projectExistingAgentRuntimeOptions(["kimi-sdk"], "kimi-sdk", {
      grokRuntimeEnabled: false,
    }).find((option) => option.runtimeId === "kimi-sdk");

    assert.equal(currentOnlyOption?.availableForNew, false);
    assert.equal(currentOnlyOption?.manageableForCurrentAgent, true);
    assert.deepEqual(currentOnlyOption?.formDefinitionRef, KIMI_SDK_FORM_DEFINITION_REF);
  } finally {
    kimiRuntime.deprecated = wasDeprecated;
  }
});

test("existing Grok is grandfathered while new transitions remain absent", () => {
  const existingGrok = projectExistingAgentRuntimeOptions(["codex", "grok"], "grok", {
    grokRuntimeEnabled: false,
  });
  assert.deepEqual(existingGrok.find((option) => option.runtimeId === "grok"), {
    runtimeId: "grok",
    capabilityStatus: "available",
    admissionStatus: "grandfathered_current",
    admissionReason: "feature_flag_off",
    current: true,
    availableForNew: false,
    manageableForCurrentAgent: true,
    canSelectInThisContext: true,
  });

  const unavailableCurrentGrok = projectExistingAgentRuntimeOptions(["codex"], "grok", {
    grokRuntimeEnabled: false,
  });
  assert.deepEqual(unavailableCurrentGrok.find((option) => option.runtimeId === "grok"), {
    runtimeId: "grok",
    capabilityStatus: "not_installed",
    admissionStatus: "grandfathered_current",
    admissionReason: "feature_flag_off",
    current: true,
    availableForNew: false,
    manageableForCurrentAgent: false,
    canSelectInThisContext: false,
  });

  const existingCodex = projectExistingAgentRuntimeOptions(["codex", "grok"], "codex", {
    grokRuntimeEnabled: false,
  });
  assert.equal(existingCodex.some((option) => option.runtimeId === "grok"), false);
});

test("deprecated current runtimes use the same explicit grandfathered contract", () => {
  for (const runtime of ["kimi", "antigravity"]) {
    const options = projectExistingAgentRuntimeOptions([runtime], runtime, {
      grokRuntimeEnabled: false,
    });
    assert.deepEqual(options.find((option) => option.runtimeId === runtime), {
      runtimeId: runtime,
      capabilityStatus: "available",
      admissionStatus: "grandfathered_current",
      admissionReason: "deprecated",
      current: true,
      availableForNew: false,
      manageableForCurrentAgent: true,
      canSelectInThisContext: true,
    });
    assert.equal(projectNewAgentRuntimeOptions([runtime], { grokRuntimeEnabled: false }).some((option) => option.runtimeId === runtime), false);
  }
});

test("setup options reuse new-admission policy and exclude built-in", () => {
  const disabled = projectSetupRuntimeOptions(["grok"], { grokRuntimeEnabled: false });
  assert.equal(disabled.some((option) => option.runtimeId === "grok"), false);
  assert.equal(disabled.some((option) => option.runtimeId === "builtin"), false);
  assert.equal(disabled.some((option) => option.canSelectInThisContext), false);

  const enabled = projectSetupRuntimeOptions(["grok"], { grokRuntimeEnabled: true });
  assert.equal(enabled.find((option) => option.runtimeId === "grok")?.canSelectInThisContext, true);
});
