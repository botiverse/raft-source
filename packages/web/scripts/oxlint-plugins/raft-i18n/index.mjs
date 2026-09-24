/**
 * Local Oxlint JS plugin (ESLint-compatible) for i18n call-sink + .ts return prose.
 */

import noLiteralInMessageCall from "./no-literal-message-call.mjs";
import noLiteralReturnProse from "./no-literal-return-prose.mjs";

const plugin = {
  meta: {
    name: "raft-i18n",
  },
  rules: {
    "no-literal-in-message-call": noLiteralInMessageCall,
    "no-literal-return-prose": noLiteralReturnProse,
  },
};

export default plugin;
