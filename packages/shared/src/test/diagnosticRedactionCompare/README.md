# Redaction comparison

Checks that a change to `diagnosticRedaction.ts` / `runtimeErrorVisibility.ts`
leaves nothing visible that a base ref masked, on all four surfaces (runtime
error text, `redactDiagnosticText`, counted mode, `redactDiagnosticCredentials`).
From the repository root, against one or more base refs:

    node --import @oxc-node/core/register packages/shared/src/test/diagnosticRedactionCompare/compare.ts --base origin/staging

It exits 1 and prints each newly visible word, except labels and the words in
`INTENDED_UNMASKED`. Add new probe inputs to `corpus.ts`.
