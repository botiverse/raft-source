import { readFile } from "node:fs/promises";
import path from "node:path";

export type PlaywrightSeedState = {
  scenarioCapability?: string;
  user: {
    email: string;
    password: string;
    name: string;
  };
  server: {
    id: string;
    slug: string;
    name: string;
  };
  channel: {
    id: string;
    name: string;
  };
  messages: {
    total: number;
    latestContent: string;
    focusMessageId: string;
  };
  agent: {
    id: string;
    name: string;
  };
  machine: {
    id: string;
    name: string;
  };
  extraHuman: {
    userId: string;
    email: string;
    password: string;
    name: string;
  };
  legacyTask: {
    id: string;
    taskNumber: number;
    title: string;
  };
  announcement: {
    id: string;
    title: string;
    pages: Array<{ title?: string; body: string }>;
  };
  urls: {
    api: string;
    web: string;
  };
};

export type ScenarioSeedState = Pick<PlaywrightSeedState, "user" | "server" | "channel" | "urls">;

export const STATE_DIR = path.resolve(process.cwd(), ".playwright", "state");
export const SEED_STATE_PATH = process.env.SLOCK_TEST_STATE_PATH
  ? path.resolve(process.env.SLOCK_TEST_STATE_PATH)
  : path.join(STATE_DIR, "playwright-server.json");
export const AUTH_STATE_PATH = path.join(STATE_DIR, "auth.json");

export async function waitForSeedState(timeoutMs = 60_000): Promise<PlaywrightSeedState> {
  const startedAt = Date.now();
  let lastError: unknown = null;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const raw = await readFile(SEED_STATE_PATH, "utf8");
      return JSON.parse(raw) as PlaywrightSeedState;
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  throw new Error(`Timed out waiting for Playwright seed state at ${SEED_STATE_PATH}: ${String(lastError)}`);
}
