import { strict as assert } from "node:assert";
import { test } from "vitest";
import {
  getRisingWaveConnectionTimeoutMillis,
  getRisingWaveInboxRfc056ServingMode,
} from "./risingwave.js";

test("RisingWave connection timeout defaults to a bounded fail-soft value", () => {
  assert.equal(getRisingWaveConnectionTimeoutMillis({}), 1_000);
  assert.equal(getRisingWaveConnectionTimeoutMillis({ RISINGWAVE_CONNECTION_TIMEOUT_MS: "750" }), 750);
  assert.equal(getRisingWaveConnectionTimeoutMillis({ RISINGWAVE_CONNECTION_TIMEOUT_MS: "100" }), 250);
  assert.equal(getRisingWaveConnectionTimeoutMillis({ RISINGWAVE_CONNECTION_TIMEOUT_MS: "60000" }), 10_000);
  assert.equal(getRisingWaveConnectionTimeoutMillis({ RISINGWAVE_CONNECTION_TIMEOUT_MS: "1000.9" }), 1_000);
  assert.equal(getRisingWaveConnectionTimeoutMillis({ RISINGWAVE_CONNECTION_TIMEOUT_MS: "not-a-number" }), 1_000);
});

test("RFC056 serving mode is fail-closed and requires an explicit shadow or on value", () => {
  assert.equal(getRisingWaveInboxRfc056ServingMode({}), "off");
  assert.equal(getRisingWaveInboxRfc056ServingMode({ RISINGWAVE_INBOX_RFC056_SERVING_MODE: "" }), "off");
  assert.equal(getRisingWaveInboxRfc056ServingMode({ RISINGWAVE_INBOX_RFC056_SERVING_MODE: "invalid" }), "off");
  assert.equal(getRisingWaveInboxRfc056ServingMode({ RISINGWAVE_INBOX_RFC056_SERVING_MODE: " OFF " }), "off");
  assert.equal(getRisingWaveInboxRfc056ServingMode({ RISINGWAVE_INBOX_RFC056_SERVING_MODE: " Shadow " }), "shadow");
  assert.equal(getRisingWaveInboxRfc056ServingMode({ RISINGWAVE_INBOX_RFC056_SERVING_MODE: "ON" }), "on");
});
