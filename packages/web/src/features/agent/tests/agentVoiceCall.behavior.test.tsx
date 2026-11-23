import "../../../../tests/helpers/domSetup";

import assert from "node:assert/strict";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { joinRoom } from "@holtjs/live-client";
import type { DataMessage, JoinOptions, LiveRoom } from "@holtjs/live-client";
import { AGENT_VOICE_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";

import api from "../../../api/client";
import { en } from "../../../i18n/messages/en";
import { useAuthStore } from "../../../store/authStore";
import { resetServerFeatureFlagsForTests, setServerFeatureFlagForTests } from "../../../store/serverFeatureFlags";
import { useServerStore } from "../../../store/serverStore";
import { useMachineStore } from "../../../store/machineStore";
import { TestIntlProvider } from "../../../../tests/helpers/intl";
import { AgentVoiceCallWindow } from "../AgentVoiceCallWindow";
import { readCallAnswer, startProblemOf } from "../agentVoiceCallClient";
import { useAgentVoiceCallAction } from "../agentVoiceCallEntry";
import { formatCallClock, useAgentVoiceCallStore } from "../agentVoiceCallStore";

// Raft voice calls (#wg-runtime-form:#22): the call window's states, what it
// says for every refusal, and who gets a Call button. The browser package is
// mocked: joinRoom hands back a fake room and keeps the event handlers.
vi.mock("@holtjs/live-client", () => ({ joinRoom: vi.fn() }));

const join = vi.mocked(joinRoom);
const SERVER = "server-1";
const AGENT = { id: "agent-1", name: "Wug", avatarUrl: null };
const CALL_ID = "3f1c2d4e-0000-4000-8000-000000000001";
const STARTED = { callId: CALL_ID, room: { url: "wss://live.test", token: "grant-1", expiresAt: "2026-11-16T10:10:00.000Z", relay: "cn" } };

type Handlers = NonNullable<JoinOptions["on"]>;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  join.mockReset();
  useAgentVoiceCallStore.setState(useAgentVoiceCallStore.getInitialState(), true);
  useServerStore.setState(useServerStore.getInitialState(), true);
  resetServerFeatureFlagsForTests();
  useAuthStore.setState({ user: null, accessToken: null, refreshToken: null } as never);
  for (const storage of new Set([window.localStorage, globalThis.localStorage])) storage?.removeItem("slock_access_token");
});

function fmt(id: keyof typeof en, values: Record<string, string | number> = {}) {
  return Object.entries(values).reduce((text, [key, value]) => text.replace(`{${key}}`, String(value)), en[id] as string);
}

function fakeRoom({ mic = { device: "", denoise: "soft" } }: { mic?: LiveRoom["mic"] } = {}) {
  return {
    identity: "me",
    state: "live",
    mic,
    peers: [],
    speaking: new Set<string>(),
    playbackBlocked: false,
    on: vi.fn(),
    mute: vi.fn(),
    talk: vi.fn(),
    setMic: vi.fn(async () => undefined),
    speaker: vi.fn(),
    unlockPlayback: vi.fn(async () => undefined),
    leave: vi.fn(async () => undefined),
  } satisfies LiveRoom;
}

/** api.post: the start answers `start` (a value, or a thrown error); a renewal, the grant; a hang-up, 204. */
function stubPost(start: () => Promise<unknown> = async () => ({ data: STARTED })) {
  return vi.spyOn(api, "post").mockImplementation(async (url: string) => {
    if (url.endsWith("/voice/calls")) return start() as never;
    if (url.endsWith("/token")) return { data: STARTED } as never;
    return { status: 204, data: "" } as never;
  });
}

function hangUps(post: ReturnType<typeof stubPost>) {
  return post.mock.calls.filter(([url]) => String(url).endsWith("/hang-up"));
}

/** joinRoom joins the fake room, says live, and keeps its handlers. */
function joinLive(room = fakeRoom()) {
  const seen: { on: Handlers; options: JoinOptions | null } = { on: {}, options: null };
  join.mockImplementation(async (options) => {
    seen.options = options;
    seen.on = options.on ?? {};
    seen.on.state?.("live");
    return room;
  });
  return seen;
}

function renderWindow() {
  return render(createElement(TestIntlProvider, null, createElement(AgentVoiceCallWindow)));
}

function call() {
  act(() => useAgentVoiceCallStore.getState().startCall(AGENT, SERVER));
}

function stateText() {
  return screen.getByTestId("agent-voice-call-state").textContent;
}

function phase() {
  return screen.getByTestId("agent-voice-call-window").getAttribute("data-phase");
}

function notesText() {
  return screen.queryByTestId("agent-voice-call-notes")?.textContent ?? "";
}

/** A promise settled from the test. */
function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

/** A data message; `topic: null` sends it with no topic (undefined would take the default). */
function data(payload: unknown, topic: string | null = "caption"): DataMessage {
  return { ...(topic ? { topic } : {}), data: payload, bytes: new Uint8Array() };
}

/** A caption as holt-live publishes it (topic "caption"). */
function caption(role: "user" | "agent", text: string, id: string, final = true): DataMessage {
  return data({ type: "caption", role, text, final, id });
}

/** A call that is live, with the room's handlers. */
async function liveCall(room = fakeRoom()) {
  const post = stubPost();
  const seen = joinLive(room);
  renderWindow();
  call();
  await waitFor(() => assert.equal(stateText(), "0:00"));
  return { ...seen, post, room };
}

function captionsText() {
  return screen.getByTestId("agent-voice-call-captions").textContent ?? "";
}

test("a refusal or a failure reads as a plain reason, never a code", () => {
  const refused = (status: number, code?: string) => Object.assign(new Error("refused"), { response: { status, data: code ? { code } : {} } });
  assert.equal(startProblemOf(refused(404)), "not_allowed");
  assert.equal(startProblemOf(refused(409, "agent_offline")), "agent_offline");
  assert.equal(startProblemOf(refused(409, "voice_call_unavailable")), "unavailable");
  assert.equal(startProblemOf(refused(409, "unsupported_runtime")), "unsupported_runtime");
  assert.equal(startProblemOf(refused(409, "toString")), "failed");
  assert.equal(startProblemOf(refused(429)), "rate_limited");
  assert.equal(startProblemOf(refused(500)), "failed");
  assert.equal(startProblemOf(new Error("Network Error")), "failed");
});

test("the start's answer is read at the boundary: a call id the server minted, and only a whole grant", () => {
  assert.deepEqual(readCallAnswer(STARTED), { callId: CALL_ID, room: { url: "wss://live.test", token: "grant-1", expiresAt: Date.parse(STARTED.room.expiresAt) } });
  assert.equal(readCallAnswer({ ...STARTED, callId: "call-1" }).callId, null);
  assert.equal(readCallAnswer({ ...STARTED, room: { ...STARTED.room, expiresAt: "soon" } }).room, null);
  assert.equal(readCallAnswer({ ...STARTED, room: { ...STARTED.room, url: "" } }).room, null);
  assert.equal(readCallAnswer({ ...STARTED, room: { ...STARTED.room, token: 7 } }).room, null);
  assert.deepEqual(readCallAnswer(null), { callId: null, room: null });
});

test("a call: connecting, live with a timer, captions, speaking, mute and sound; hung up, it says how long and where the record is", async () => {
  const post = stubPost();
  const room = fakeRoom();
  const seen = joinLive(room);
  renderWindow();
  call();
  assert.equal(stateText(), en["agent.voice.call.connecting"]);

  await waitFor(() => assert.equal(stateText(), "0:00"));
  // The clock ticks outside any live region; the screen reader hears the phase once.
  assert.equal(screen.getByTestId("agent-voice-call-announcement").textContent, en["agent.voice.call.connected"]);
  assert.equal(screen.getByTestId("agent-voice-call-state").getAttribute("aria-live"), null);
  // The start names the call's server; joinRoom gets the room grant and nothing else (the region relay isn't a TURN relay).
  assert.deepEqual(post.mock.calls[0], ["/agents/agent-1/voice/calls", {}, { headers: { "X-Server-Id": SERVER } }]);
  assert.equal(seen.options?.url, "wss://live.test");
  assert.equal(seen.options?.token, "grant-1");
  assert.equal(seen.options?.expiresAt, Date.parse(STARTED.room.expiresAt));
  assert.equal(seen.options?.relay, null);
  assert.deepEqual(await seen.options?.renew?.(), { token: "grant-1", expiresAt: Date.parse(STARTED.room.expiresAt) });
  assert.equal(post.mock.calls[1]?.[0], `/agents/agent-1/voice/calls/${CALL_ID}/token`);

  // The last two caption lines, each under its speaker.
  act(() => {
    seen.on.data?.(caption("agent", "Hello there", "c1"));
    seen.on.data?.(caption("user", "Hi", "c2"));
    seen.on.data?.(caption("agent", "How can I help?", "c3"));
  });
  const captions = captionsText();
  assert.ok(captions.includes("Hi") && captions.includes("How can I help?"), captions);
  assert.ok(!captions.includes("Hello there"), captions);
  assert.ok(captions.includes(fmt("agent.voice.call.captionWho", { name: en["agent.voice.call.you"] })), captions);

  // The agent speaking marks its face; the person's own voice doesn't.
  act(() => {
    seen.on.peers?.([{ identity: "me", name: "Olive", kind: "human", local: true }, { identity: "agent", name: "Wug", kind: "agent", local: false }]);
    seen.on.speaking?.("me", true);
  });
  assert.equal(screen.getByTestId("agent-voice-call-name").getAttribute("data-speaking"), null);
  act(() => seen.on.speaking?.("agent", true));
  assert.equal(screen.getByTestId("agent-voice-call-name").getAttribute("data-speaking"), "true");

  // Toggles keep their names; aria-pressed says their state, lit only when something is off (Mute pressed: muted; Sound off pressed: off).
  const mute = () => screen.getByTestId("agent-voice-call-mute");
  const sound = () => screen.getByTestId("agent-voice-call-sound");
  assert.equal(mute().getAttribute("aria-pressed"), "false");
  fireEvent.click(mute());
  assert.deepEqual(room.mute.mock.calls, [[true]]);
  assert.equal(mute().getAttribute("aria-pressed"), "true");
  assert.equal(mute().getAttribute("aria-label"), en["agent.voice.call.mute"]);
  assert.ok(mute().querySelector("[class*='mic-off']") !== null, "muted: the MicOff icon");

  // The browser holds the sound back: Sound off is lit, a click plays it, and the window says why.
  assert.equal(sound().getAttribute("aria-pressed"), "false");
  act(() => seen.on.playback?.(true));
  assert.equal(sound().getAttribute("aria-label"), en["agent.voice.call.soundOff"]);
  assert.equal(sound().getAttribute("aria-pressed"), "true");
  assert.ok(notesText().includes(fmt("agent.voice.call.playbackBlocked", { name: "Wug" })));
  fireEvent.click(sound());
  assert.equal(room.unlockPlayback.mock.calls.length, 1);
  act(() => seen.on.playback?.(false));
  fireEvent.click(sound());
  assert.deepEqual(room.speaker.mock.calls, [[false]]);
  assert.equal(sound().getAttribute("aria-pressed"), "true");
  assert.ok(sound().querySelector("[class*='volume-off']") !== null, "sound off: the VolumeOff icon");
  assert.equal(sound().getAttribute("aria-label"), en["agent.voice.call.soundOff"]);

  // A microphone lost mid-call is said in words for a call that goes on.
  act(() => seen.on.mic?.({ device: "", denoise: "soft", blocked: "busy" }));
  // A warning banner, not caption text; Mute is unavailable, with the reason on its tooltip's trigger.
  assert.equal(screen.getByTestId("agent-voice-call-mic").textContent, fmt("agent.voice.call.micLive.busy", { name: "Wug" }));
  assert.ok(!notesText().includes(fmt("agent.voice.call.micLive.busy", { name: "Wug" })), notesText());
  assert.ok(mute().hasAttribute("disabled") || mute().getAttribute("aria-disabled") === "true", "Mute unavailable");
  assert.equal(mute().getAttribute("aria-label"), en["agent.voice.call.mute"]);
  act(() => seen.on.mic?.({ device: "", denoise: "soft" }));
  assert.ok(screen.queryByTestId("agent-voice-call-mic") === null, "no microphone warning once it's back");
  assert.ok(!mute().hasAttribute("disabled") && mute().getAttribute("aria-disabled") !== "true", "Mute available again");

  fireEvent.click(screen.getByTestId("agent-voice-call-hang-up"));
  assert.equal(room.leave.mock.calls.length, 1);
  assert.deepEqual(hangUps(post), [[`/agents/agent-1/voice/calls/${CALL_ID}/hang-up`, {}, { headers: { "X-Server-Id": SERVER } }]]);
  assert.equal(screen.getByTestId("agent-voice-call-window").getAttribute("data-phase"), "ended");
  assert.match(stateText() ?? "", /^Call ended · 0:0\d$/);
  assert.equal(screen.getByTestId("agent-voice-call-announcement").textContent, stateText());
  assert.ok(notesText().includes(fmt("agent.voice.call.record", { name: "Wug" })));
  assert.ok(!notesText().includes(en["agent.voice.call.connectionLost"]), notesText());
  assert.ok(screen.queryByTestId("agent-voice-call-captions") === null, "no agent-voice-call-captions");

  // The room's own end after the hang-up changes nothing and tells the server nothing more.
  act(() => seen.on.state?.("ended", "left"));
  assert.equal(hangUps(post).length, 1);

  fireEvent.click(screen.getByTestId("agent-voice-call-close"));
  assert.ok(screen.queryByTestId("agent-voice-call-window") === null, "no agent-voice-call-window");
});

test("every refusal of the start is said in the window, and nothing is joined", async () => {
  const cases: Array<[number, string | undefined, string]> = [
    [404, undefined, en["agent.voice.call.problem.notAllowed"]],
    [409, "agent_offline", fmt("agent.voice.call.problem.agentOffline", { name: "Wug" })],
    [409, "voice_call_unavailable", en["agent.voice.call.problem.unavailable"]],
    [409, "unsupported_runtime", fmt("agent.voice.call.problem.unsupportedRuntime", { name: "Wug" })],
    [429, undefined, en["agent.voice.call.problem.rateLimited"]],
    [500, undefined, en["agent.voice.call.problem.failed"]],
  ];
  for (const [status, code, sentence] of cases) {
    const post = stubPost(async () => {
      throw Object.assign(new Error("refused"), { response: { status, data: code ? { code } : {} } });
    });
    renderWindow();
    call();
    await waitFor(() => assert.equal(screen.getByTestId("agent-voice-call-window").getAttribute("data-phase"), "failed"));
    assert.equal(stateText(), en["agent.voice.call.notConnected"]);
    assert.equal(screen.getByTestId("agent-voice-call-notes").textContent, sentence);
    assert.ok(screen.queryByTestId("agent-voice-call-hang-up") === null, "no agent-voice-call-hang-up");
    assert.equal(join.mock.calls.length, 0);
    assert.equal(hangUps(post).length, 0);
    fireEvent.click(screen.getByTestId("agent-voice-call-close"));
    assert.ok(screen.queryByTestId("agent-voice-call-window") === null, "no agent-voice-call-window");
    cleanup();
    vi.restoreAllMocks();
  }
});

test("a join that fails ends the call on the server and says it couldn't connect", async () => {
  const post = stubPost();
  join.mockRejectedValue(Object.assign(new Error("unreachable"), { code: "unreachable" }));
  renderWindow();
  call();
  await waitFor(() => assert.equal(screen.getByTestId("agent-voice-call-window").getAttribute("data-phase"), "failed"));
  assert.equal(screen.getByTestId("agent-voice-call-notes").textContent, en["agent.voice.call.problem.failed"]);
  assert.equal(hangUps(post).length, 1);
});

test("a microphone the browser refuses at the join ends the call and says how to fix it", async () => {
  const post = stubPost();
  const room = fakeRoom({ mic: { device: "", denoise: "soft", blocked: "permission" } });
  joinLive(room);
  renderWindow();
  call();
  await waitFor(() => assert.equal(screen.getByTestId("agent-voice-call-window").getAttribute("data-phase"), "failed"));
  assert.equal(screen.getByTestId("agent-voice-call-notes").textContent, en["agent.voice.call.mic.permission"]);
  assert.equal(room.leave.mock.calls.length, 1);
  assert.equal(hangUps(post).length, 1);
});

test("the server closing the room ends the call without a hang-up from the browser", async () => {
  const { on, post } = await liveCall();
  act(() => on.state?.("reconnecting"));
  assert.equal(stateText(), en["agent.voice.call.reconnecting"]);
  assert.equal(screen.getByTestId("agent-voice-call-announcement").textContent, en["agent.voice.call.reconnecting"]);
  act(() => on.state?.("ended", "closed"));
  assert.equal(phase(), "ended");
  assert.equal(hangUps(post).length, 0);
  // A short call the server closed is not the limit.
  assert.ok(!notesText().includes(fmt("agent.voice.call.limit", { minutes: 15 })), notesText());
});

test("the server closing the room at the 15-minute limit says so", async () => {
  const { on, post } = await liveCall();
  const now = useAgentVoiceCallStore.getState().call!;
  // Live since 14:30 ago: within a minute of the limit.
  act(() => useAgentVoiceCallStore.setState({ call: { ...now, liveSince: Date.now() - (15 * 60 - 30) * 1000 } }));
  act(() => on.state?.("ended", "closed"));
  assert.match(stateText() ?? "", /^Call ended · 14:3\d$/);
  assert.ok(notesText().includes(fmt("agent.voice.call.limit", { minutes: 15 })), notesText());
  assert.equal(hangUps(post).length, 0);
});

test("a lost line ends the call, says so, and hangs up once", async () => {
  const { on, post, room } = await liveCall();
  act(() => on.state?.("ended", "lost"));
  assert.equal(phase(), "ended");
  assert.ok(notesText().includes(en["agent.voice.call.connectionLost"]), notesText());
  assert.equal(room.leave.mock.calls.length, 1);
  assert.equal(hangUps(post).length, 1);
  act(() => on.state?.("ended", "lost"));
  assert.equal(hangUps(post).length, 1);
});

test("a grant the browser can't join with ends the call as failed, on the server too", async () => {
  const post = stubPost(async () => ({ data: { ...STARTED, room: { ...STARTED.room, expiresAt: "soon" } } }));
  renderWindow();
  call();
  await waitFor(() => assert.equal(phase(), "failed"));
  assert.equal(notesText(), en["agent.voice.call.problem.failed"]);
  assert.equal(join.mock.calls.length, 0);
  assert.equal(hangUps(post).length, 1);
});

test("hanging up while the room is joining closes the window, ends the call on the server, and leaves the room once it is joined", async () => {
  const post = stubPost();
  const room = fakeRoom();
  const joined = deferred<LiveRoom>();
  join.mockImplementation(() => joined.promise);
  renderWindow();
  call();
  await waitFor(() => assert.equal(join.mock.calls.length, 1));
  fireEvent.click(screen.getByTestId("agent-voice-call-hang-up"));
  assert.ok(screen.queryByTestId("agent-voice-call-window") === null, "no agent-voice-call-window");
  assert.equal(hangUps(post).length, 1);
  assert.equal(join.mock.calls[0]?.[0].signal?.aborted, true);
  await act(async () => joined.resolve(room));
  await waitFor(() => assert.equal(room.leave.mock.calls.length, 1));
  assert.equal(hangUps(post).length, 1);
});

test("Mute and Sound pressed while the room is still joining are applied once it is joined", async () => {
  stubPost();
  const room = fakeRoom();
  const joined = deferred<LiveRoom>();
  join.mockImplementation((options) => {
    options.on?.state?.("live"); // live before joinRoom resolves: the buttons show, there is no room yet
    return joined.promise;
  });
  renderWindow();
  call();
  await waitFor(() => assert.equal(stateText(), "0:00"));
  fireEvent.click(screen.getByTestId("agent-voice-call-mute"));
  fireEvent.click(screen.getByTestId("agent-voice-call-sound"));
  assert.equal(screen.getByTestId("agent-voice-call-mute").getAttribute("aria-pressed"), "true");
  assert.equal(screen.getByTestId("agent-voice-call-sound").getAttribute("aria-pressed"), "true");
  await act(async () => joined.resolve(room));
  await waitFor(() => assert.deepEqual(room.mute.mock.calls, [[true]]));
  assert.deepEqual(room.speaker.mock.calls, [[false]]);
});

test("logging out during a call leaves the room and hangs up once, with the session's token", async () => {
  window.localStorage.setItem("slock_access_token", "token-1");
  useAuthStore.setState({ user: { id: "user-1", name: "olive" }, accessToken: "token-1", refreshToken: null } as never);
  const { room, post } = await liveCall();
  const tokens: Array<string | null> = [];
  post.mockImplementation(async (url: string) => {
    if (String(url).endsWith("/hang-up")) tokens.push(window.localStorage.getItem("slock_access_token"));
    return { status: 204, data: "" } as never;
  });
  act(() => useAuthStore.getState().logout());
  assert.equal(room.leave.mock.calls.length, 1);
  assert.deepEqual(tokens, ["token-1"]);
  assert.equal(window.localStorage.getItem("slock_access_token"), null);
  assert.equal(useAgentVoiceCallStore.getState().call, null);
  assert.ok(screen.queryByTestId("agent-voice-call-window") === null, "no agent-voice-call-window");
});

test("hanging up while the call is being placed closes the window and still ends the call on the server", async () => {
  let answer: (value: unknown) => void = () => undefined;
  const post = stubPost(() => new Promise((resolve) => { answer = resolve; }));
  renderWindow();
  call();
  fireEvent.click(screen.getByTestId("agent-voice-call-hang-up"));
  assert.ok(screen.queryByTestId("agent-voice-call-window") === null, "no agent-voice-call-window");
  await act(async () => answer({ data: STARTED }));
  await waitFor(() => assert.equal(hangUps(post).length, 1));
  assert.equal(join.mock.calls.length, 0);
});

test("Call on another agent during a call brings the open window forward and starts nothing", async () => {
  const post = stubPost();
  joinLive();
  renderWindow();
  call();
  await waitFor(() => assert.equal(stateText(), "0:00"));
  act(() => useAgentVoiceCallStore.getState().startCall({ id: "agent-2", name: "Bugen", avatarUrl: null }, SERVER));
  assert.equal(post.mock.calls.filter(([url]) => String(url).endsWith("/voice/calls")).length, 1);
  assert.ok(document.activeElement === screen.getByTestId("agent-voice-call-window"), "the call window has the focus");
  assert.equal(screen.getByTestId("agent-voice-call-name").textContent, "Wug");
});

test("captions: an unfinished line is replaced by its finished one, by id", async () => {
  const seen = await liveCall();
  act(() => {
    seen.on.data?.(caption("user", "Can you", "u1", false));
    seen.on.data?.(caption("user", "Can you check the deploy", "u1", false));
  });
  assert.equal(captionsText().split("Can you").length - 1, 1, captionsText());
  act(() => seen.on.data?.(caption("agent", "Sure", "a1", false)));
  act(() => seen.on.data?.(caption("user", "Can you check the deploy?", "u1", true)));
  // Still two lines: the person's, finished in place, and the agent's unfinished one after it.
  const text = captionsText();
  assert.ok(text.includes("Can you check the deploy?") && text.includes("Sure"), text);
  assert.ok(text.indexOf("Can you check the deploy?") < text.indexOf("Sure"), text);
  assert.equal(screen.getByTestId("agent-voice-call-captions").children.length, 2);
});

test("captions: other topics and other shapes are ignored", async () => {
  const seen = await liveCall();
  act(() => {
    seen.on.data?.(data({ type: "caption", role: "agent", text: "wrong topic", final: true, id: "x1" }, "status"));
    seen.on.data?.(data({ type: "caption", role: "agent", text: "no topic", final: true, id: "x2" }, null));
    seen.on.data?.(data({ type: "status", role: "agent", text: "not a caption", final: true, id: "x3" }));
    seen.on.data?.(data({ type: "caption", speaker: "agent", text: "no role", final: true, id: "x4" }));
    seen.on.data?.(data({ type: "caption", role: "agent", text: "no final", id: "x5" }));
    seen.on.data?.(data({ type: "caption", role: "agent", text: "no id", final: true }));
    seen.on.data?.(data("plain text"));
  });
  assert.ok(screen.queryByTestId("agent-voice-call-captions") === null, "no captions");
  act(() => seen.on.data?.(caption("agent", "Hello", "a1")));
  assert.equal(captionsText(), `${fmt("agent.voice.call.captionWho", { name: "Wug" })}Hello`);
});

test("captions: an unfinished message arriving after its finished line is ignored", async () => {
  const { on } = await liveCall();
  act(() => {
    on.data?.(caption("agent", "The deploy is green.", "a1", true));
    on.data?.(caption("agent", "The deploy is", "a1", false)); // late, over the unreliable channel
  });
  assert.equal(captionsText(), `${fmt("agent.voice.call.captionWho", { name: "Wug" })}The deploy is green.`);
});

test("captions: a finished line with empty text withdraws the line", async () => {
  const { on } = await liveCall();
  act(() => {
    on.data?.(caption("user", "Hi", "u1", true));
    on.data?.(caption("agent", "Um", "a1", false));
  });
  act(() => on.data?.(caption("agent", "", "a1", true)));
  assert.equal(captionsText(), `${fmt("agent.voice.call.captionWho", { name: en["agent.voice.call.you"] })}Hi`);
  // And it stays withdrawn: a late unfinished message for it is ignored.
  act(() => on.data?.(caption("agent", "Um", "a1", false)));
  assert.equal(captionsText(), `${fmt("agent.voice.call.captionWho", { name: en["agent.voice.call.you"] })}Hi`);
});

test("captions: an unfinished message with empty text changes nothing", async () => {
  const { on } = await liveCall();
  act(() => on.data?.(caption("agent", "Let me check", "a1", false)));
  act(() => {
    on.data?.(caption("agent", "", "a1", false)); // not removed
    on.data?.(caption("user", "", "u9", false)); // not added
  });
  assert.equal(captionsText(), `${fmt("agent.voice.call.captionWho", { name: "Wug" })}Let me check`);
  assert.equal(screen.getByTestId("agent-voice-call-captions").children.length, 1);
  // Its finished line still replaces it in place.
  act(() => on.data?.(caption("agent", "Let me check the deploy.", "a1", true)));
  assert.equal(captionsText(), `${fmt("agent.voice.call.captionWho", { name: "Wug" })}Let me check the deploy.`);
});

test("a call's length reads as m:ss", () => {
  assert.equal(formatCallClock(0), "0:00");
  assert.equal(formatCallClock(192_400), "3:12");
});

test("a Call button only with the flag on, for a member, for an agent that can take a call", () => {
  useServerStore.setState({ current: { id: SERVER, slug: "s", name: "S", role: "member" } } as never);
  const agent = { id: "agent-1", name: "wug", displayName: "Wug", avatarUrl: null, deletedAt: null, managedByAppInstallId: null };
  setServerFeatureFlagForTests(SERVER, AGENT_VOICE_FEATURE_FLAG_KEY, false);
  assert.equal(renderHook(() => useAgentVoiceCallAction(agent)).result.current, undefined);

  setServerFeatureFlagForTests(SERVER, AGENT_VOICE_FEATURE_FLAG_KEY, true);
  const { result } = renderHook(() => useAgentVoiceCallAction(agent));
  assert.equal(typeof result.current, "function");
  assert.equal(renderHook(() => useAgentVoiceCallAction({ ...agent, deletedAt: "2026-11-01T00:00:00.000Z" })).result.current, undefined);
  assert.equal(renderHook(() => useAgentVoiceCallAction({ ...agent, managedByAppInstallId: "install-1" })).result.current, undefined);
  // No button where a call can't go through: a stopped agent, or its Computer known to be offline. Idle is callable.
  assert.equal(renderHook(() => useAgentVoiceCallAction({ ...agent, status: "stopped" })).result.current, undefined);
  assert.equal(typeof renderHook(() => useAgentVoiceCallAction({ ...agent, status: "inactive" })).result.current, "function");
  useMachineStore.setState({ machines: [{ id: "machine-1", status: "offline" }] } as never);
  assert.equal(renderHook(() => useAgentVoiceCallAction({ ...agent, machineId: "machine-1" })).result.current, undefined);
  useMachineStore.setState({ machines: [] } as never);
  assert.equal(renderHook(() => useAgentVoiceCallAction(null)).result.current, undefined);

  // Pressed: a call to the agent on this server, under its display name.
  stubPost(() => new Promise(() => undefined));
  act(() => result.current?.());
  assert.deepEqual(useAgentVoiceCallStore.getState().call?.agent, { id: "agent-1", name: "Wug", avatarUrl: null });
  assert.equal(useAgentVoiceCallStore.getState().call?.serverId, SERVER);

  useServerStore.setState({ current: { id: SERVER, slug: "s", name: "S", role: "guest" } } as never);
  assert.equal(renderHook(() => useAgentVoiceCallAction(agent)).result.current, undefined);
});
