import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { RuntimeFormV2Definition } from "@botiverse/raft-runtime-form";

import {
  localizeRuntimeFormV2,
  localizeRuntimeFormV2OptionSource,
  RUNTIME_FORM_V2_COPY_TABLES,
  RUNTIME_FORM_V2_ZH_CN_COPY,
  runtimeFormCopyLocale,
} from "./runtimeFormV2Copy";
import { buildRuntimeFormV2, runtimeFormV2RuntimeIds } from "./runtimeFormV2Registry";

const FIXTURES_DIR = fileURLToPath(new URL("../../../runtime-form/fixtures/", import.meta.url));

// Copy that reads the same in Chinese: identifiers, placeholders and the effort
// level names the web app also keeps in English.
const SAME_IN_ZH_CN = new Set([
  "API URL",
  "Base URL",
  "claude",
  "sk-...",
  "sk-ant-...",
  // #proj-runtime:#50: the model-limit placeholders are numbers.
  "200000",
  "8192",
  "https://gateway.example.com",
  "https://gateway.example.com/v1",
  "Minimal",
  "Low",
  "Medium",
  "High",
  "Extra high",
  "Max",
  "Ultra",
]);

function copyStrings(form: RuntimeFormV2Definition): string[] {
  const out: string[] = [];
  for (const copy of Object.values(form.uiSchema?.localization ?? {})) {
    for (const text of [copy.label, copy.hint, copy.placeholder]) if (typeof text === "string") out.push(text);
    for (const choice of Object.values(copy.choices ?? {})) {
      out.push(choice.label);
      if (typeof choice.description === "string") out.push(choice.description);
    }
  }
  return out;
}

test("Accept-Language picks the Chinese table for any Chinese range and English otherwise", () => {
  assert.equal(runtimeFormCopyLocale(undefined), "en");
  assert.equal(runtimeFormCopyLocale(""), "en");
  assert.equal(runtimeFormCopyLocale("zh-CN"), "zh-cn");
  assert.equal(runtimeFormCopyLocale("zh"), "zh-cn");
  assert.equal(runtimeFormCopyLocale("zh-Hans-CN,zh;q=0.9"), "zh-cn");
  assert.equal(runtimeFormCopyLocale("en-US,en;q=0.9,zh-CN;q=0.8"), "en");
  assert.equal(runtimeFormCopyLocale("en;q=0.5,zh-CN;q=0.8"), "zh-cn");
  assert.equal(runtimeFormCopyLocale("fr-FR,zh-CN;q=0.5"), "zh-cn");
  assert.equal(runtimeFormCopyLocale("fr-FR,de;q=0.5"), "en");
  assert.equal(runtimeFormCopyLocale("zh-CN;q=0"), "en");
  assert.equal(runtimeFormCopyLocale("zh-CN;Q=0.1,en;q=0.5"), "en");
  assert.equal(runtimeFormCopyLocale("*"), "en");
  // Chinese goes by script: Traditional tags take the Traditional table.
  assert.equal(runtimeFormCopyLocale("zh-TW,en;q=0.5"), "zh-tw");
  assert.equal(runtimeFormCopyLocale("zh-HK"), "zh-tw");
  assert.equal(runtimeFormCopyLocale("zh-Hans-HK"), "zh-cn");
});

test("Accept-Language picks the table for every other display language", () => {
  assert.equal(runtimeFormCopyLocale("ja"), "ja");
  assert.equal(runtimeFormCopyLocale("ja-JP,ja;q=0.9,en;q=0.8"), "ja");
  assert.equal(runtimeFormCopyLocale("ko-KR"), "ko");
  assert.equal(runtimeFormCopyLocale("en-US,ko;q=0.9"), "en");
  assert.equal(runtimeFormCopyLocale("fr-FR,ko;q=0.5,ja;q=0.4"), "ko");
  assert.equal(runtimeFormCopyLocale("es-MX,es;q=0.9"), "es");
  assert.equal(runtimeFormCopyLocale("pt-BR"), "pt-br");
  assert.equal(runtimeFormCopyLocale("pt-PT,pt;q=0.9"), "pt-br");
  assert.equal(runtimeFormCopyLocale("ru-RU,ru;q=0.9,en;q=0.8"), "ru");
});

test("every other table translates exactly the strings the zh-CN table does", () => {
  const zhKeys = Object.keys(RUNTIME_FORM_V2_ZH_CN_COPY).sort();
  for (const locale of Object.keys(RUNTIME_FORM_V2_COPY_TABLES) as (keyof typeof RUNTIME_FORM_V2_COPY_TABLES)[]) {
    assert.deepEqual(Object.keys(RUNTIME_FORM_V2_COPY_TABLES[locale]).sort(), zhKeys, locale);
  }
});

test("every copy string the server ships today has a zh-CN translation", () => {
  const forms: Array<[string, RuntimeFormV2Definition]> = runtimeFormV2RuntimeIds().map((id) => [id, buildRuntimeFormV2(id)]);
  // choices.* and capabilities.* are synthetic protocol fixtures, not copy the server sends.
  const shipped = (name: string) => /\.(form|edit|edit\.configured)\.json$/.test(name) && !/^(choices|capabilities)\./.test(name);
  for (const file of readdirSync(FIXTURES_DIR).filter(shipped)) {
    forms.push([file, JSON.parse(readFileSync(`${FIXTURES_DIR}${file}`, "utf8")) as RuntimeFormV2Definition]);
  }
  assert.ok(forms.length > 10, "positive control: the forms were found");
  const missing = new Set<string>();
  for (const [, form] of forms) {
    for (const text of copyStrings(form)) {
      if (!SAME_IN_ZH_CN.has(text) && !Object.hasOwn(RUNTIME_FORM_V2_ZH_CN_COPY, text)) missing.add(text);
    }
  }
  assert.deepEqual([...missing], [], "add these to the zh-CN table in runtimeFormV2Copy.ts (or SAME_IN_ZH_CN)");
});

test("localizing changes only display copy and never the input form", () => {
  for (const id of runtimeFormV2RuntimeIds()) {
    const form = buildRuntimeFormV2(id);
    const before = JSON.stringify(form);
    assert.equal(localizeRuntimeFormV2(form, "en"), form, `${id}: English is the form as built`);
    const zh = localizeRuntimeFormV2(form, "zh-cn");
    assert.equal(JSON.stringify(form), before, `${id}: the built form is not mutated`);
    const { uiSchema: zhUi, ...zhRest } = zh;
    const { uiSchema: enUi, ...enRest } = form;
    assert.deepEqual(zhRest, enRest, `${id}: everything outside uiSchema is unchanged`);
    assert.deepEqual(
      Object.keys(zhUi?.localization ?? {}),
      Object.keys(enUi?.localization ?? {}),
      `${id}: the same fields carry copy`,
    );
  }
  const builtin = localizeRuntimeFormV2(buildRuntimeFormV2("builtin"), "zh-cn");
  assert.equal(builtin.uiSchema?.localization?.providerId?.label, "提供方");
  assert.equal(builtin.uiSchema?.localization?.model?.hint, "请填写所选提供方支持的模型 ID。");
});

test("option sources translate generic labels only; values and model names stay", () => {
  const source = {
    sourceId: "model",
    kind: "dependent_select",
    options: [
      { value: "default", label: "Default" },
      { value: "claude-opus-5-5", label: "Claude Opus 5.5" },
    ],
    optionsByValue: { custom: [{ value: "auto", label: "Auto" }] },
    defaultValue: "default",
  };
  const zh = localizeRuntimeFormV2OptionSource(source, "zh-cn");
  assert.deepEqual(zh.options, [
    { value: "default", label: "默认" },
    { value: "claude-opus-5-5", label: "Claude Opus 5.5" },
  ]);
  assert.deepEqual(zh.optionsByValue, { custom: [{ value: "auto", label: "自动" }] });
  assert.equal(zh.defaultValue, "default");
  assert.equal(source.options[0].label, "Default", "the input source is not mutated");
  assert.equal(localizeRuntimeFormV2OptionSource(source, "en"), source);
});
