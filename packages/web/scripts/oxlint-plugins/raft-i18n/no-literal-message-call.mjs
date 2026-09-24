/**
 * Flag user-facing English literals in toast/setError/setStatus call sinks.
 * Does not match Error constructors or throw new Error(...).
 */

import { looksEnglish } from "../../i18n-literal-heuristics.mjs";
import { collectStaticStringNodes, stringNodeText } from "./static-prose.mjs";

const TOAST_METHODS = new Set(["error", "success", "info", "warning", "message"]);
const IDENT_SINKS = new Set(["setError", "setStatus", "setStatusMessage"]);

function isMessageCall(callee) {
  if (!callee) return false;
  if (callee.type === "Identifier" && IDENT_SINKS.has(callee.name)) return true;
  if (
    callee.type === "MemberExpression" &&
    !callee.computed &&
    callee.object?.type === "Identifier" &&
    callee.object.name === "toast" &&
    callee.property?.type === "Identifier" &&
    TOAST_METHODS.has(callee.property.name)
  ) {
    return true;
  }
  return false;
}

const rule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow hardcoded English in toast.error|success|info|warning|message and setError|setStatus|setStatusMessage first args (including logical/conditional/template/static-concat and TS wrappers)",
    },
    schema: [],
    messages: {
      literalInMessageCall:
        "Hardcoded user-facing string in message-call sink; use formatMessage / catalog.",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        if (!isMessageCall(node.callee)) return;
        const firstArg = node.arguments?.[0];
        if (!firstArg) return;
        for (const strNode of collectStaticStringNodes(firstArg)) {
          const text = stringNodeText(strNode);
          if (!looksEnglish(text)) continue;
          context.report({ node: strNode, messageId: "literalInMessageCall" });
        }
      },
    };
  },
};

export default rule;
