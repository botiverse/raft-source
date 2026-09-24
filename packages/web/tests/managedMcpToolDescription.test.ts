import assert from "node:assert/strict";
import test from "node:test";
import { normalizeManagedMcpToolDescription } from "../src/components/agent/managedMcpToolDescription.js";

test("managed MCP tool descriptions hide provider markup without hiding its text", () => {
  assert.equal(
    normalizeManagedMcpToolDescription(
      "Lists users. <examples>1. List all users: {} 2. Search: {\"query\": \"john\"}</examples>",
    ),
    "Lists users. 1. List all users: {} 2. Search: {\"query\": \"john\"}",
  );
  assert.equal(
    normalizeManagedMcpToolDescription("Use <example kind=\"query\"> { \"page_size\": 20 } </example> safely."),
    "Use { \"page_size\": 20 } safely.",
  );
});

test("managed MCP tool description normalization preserves ordinary comparison text", () => {
  assert.equal(
    normalizeManagedMcpToolDescription("Return values when count < 5 or count > 10."),
    "Return values when count < 5 or count > 10.",
  );
});
