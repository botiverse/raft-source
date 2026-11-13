import assert from "node:assert/strict";
import { deriveRuntimeEndpoints } from "../src/runtimeEndpoints";

test("the compiled API origin wins; without it the API is on the page origin", () => {
  assert.deepEqual(
    deriveRuntimeEndpoints("https://compiled.invalid", "https://page.invalid"),
    {
      apiOrigin: "https://compiled.invalid",
      apiBase: "https://compiled.invalid/api",
      socketOrigin: "https://compiled.invalid",
    },
  );
  assert.deepEqual(
    deriveRuntimeEndpoints("", "https://page.invalid"),
    {
      apiOrigin: "https://page.invalid",
      apiBase: "https://page.invalid/api",
      socketOrigin: "/",
    },
  );
  assert.deepEqual(
    deriveRuntimeEndpoints("", ""),
    { apiOrigin: "", apiBase: "/api", socketOrigin: "/" },
  );
});
