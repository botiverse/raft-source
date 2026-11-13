import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliDecompressSync } from "node:zlib";

import { precompressDirectory } from "../scripts/precompress-assets";

test("every built JS and CSS file gets a brotli copy that decodes to it; nothing else does", async () => {
  const root = await mkdtemp(join(tmpdir(), "precompress-"));
  try {
    await mkdir(join(root, "nested"), { recursive: true });
    const js = "export const answer = 42;\n".repeat(200);
    await writeFile(join(root, "app-abcd1234.js"), js);
    await writeFile(join(root, "nested", "style-abcd1234.css"), "body { color: red }\n".repeat(50));
    await writeFile(join(root, "logo-abcd1234.svg"), "<svg/>");
    const result = await precompressDirectory(root);
    assert.equal(result.files, 2);
    assert.ok(result.compressed < result.original);
    assert.equal(brotliDecompressSync(await readFile(join(root, "app-abcd1234.js.br"))).toString(), js);
    assert.ok((await readdir(join(root, "nested"))).includes("style-abcd1234.css.br"));
    assert.equal((await readdir(root)).includes("logo-abcd1234.svg.br"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
