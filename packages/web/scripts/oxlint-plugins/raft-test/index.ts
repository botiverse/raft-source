/**
 * Local Oxlint JS plugin (ESLint-compatible) for test-code hazards.
 */

import noDomNodeInAssert from "./no-dom-node-in-assert.ts";

const plugin = {
  meta: {
    name: "raft-test",
  },
  rules: {
    "no-dom-node-in-assert": noDomNodeInAssert,
  },
};

export default plugin;
