import "./helpers/domSetup";

import assert from "node:assert/strict";
import api from "../src/api/client";
import { readAgentVoiceQuestions, readAgentVoiceSettings, saveAgentVoiceSettings } from "../src/features/agent/agentVoiceClient";

// Raft voice: the Voice section shows only for whoever the server answers;
// its routes answer 404 to anyone else (or with the flag off): nothing to show.
test("voice settings and askers read as null on a 404, and a change is a PUT of the field", async () => {
  const originalGet = api.get;
  const originalPut = api.put;
  const calls: Array<[string, unknown]> = [];
  try {
    api.get = (async (url: string) => {
      if (url.endsWith("/voice-settings")) throw Object.assign(new Error("nf"), { response: { status: 404 } });
      return { data: { questions: [{ asker: null, at: "2026-11-13T19:00:00.000Z", app: { name: "Deck" } }] } };
    }) as typeof api.get;
    api.put = (async (url: string, body: unknown) => {
      calls.push([url, body]);
      return { data: { askable: false, callable: true } };
    }) as typeof api.put;
    assert.equal(await readAgentVoiceSettings("a 1"), null);
    assert.deepEqual(await readAgentVoiceQuestions("a1"), [{ asker: null, at: "2026-11-13T19:00:00.000Z", app: { name: "Deck" } }]);
    assert.deepEqual(await saveAgentVoiceSettings("a1", { askable: false }), { askable: false, callable: true });
    assert.deepEqual(calls, [["/agents/a1/voice-settings", { askable: false }]]);
  } finally {
    api.get = originalGet;
    api.put = originalPut;
  }
});
