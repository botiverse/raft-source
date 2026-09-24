let input = "";
for await (const chunk of process.stdin) input += chunk;

const args = process.argv.slice(2);
const requireComplete = args.includes("--require-complete");
if (args.some((arg) => arg !== "--require-complete")) {
  process.stderr.write("Could not classify object inventory\n");
  process.exit(1);
}

function fail() {
  throw new Error("Could not classify object inventory");
}

try {
  const response = JSON.parse(input);
  if (
    response === null ||
    typeof response !== "object" ||
    Array.isArray(response)
  )
    fail();

  const hasContents = Object.hasOwn(response, "Contents");
  const contents = hasContents ? response.Contents : [];
  if (!Array.isArray(contents)) fail();
  if (
    contents.some(
      (entry) =>
        entry === null ||
        typeof entry !== "object" ||
        Array.isArray(entry) ||
        typeof entry.Key !== "string" ||
        entry.Key.length === 0,
    )
  ) {
    fail();
  }

  if (Object.hasOwn(response, "KeyCount")) {
    if (!Number.isSafeInteger(response.KeyCount) || response.KeyCount < 0)
      fail();
    if (response.KeyCount !== contents.length) fail();
  }

  if (
    Object.hasOwn(response, "IsTruncated") &&
    typeof response.IsTruncated !== "boolean"
  )
    fail();
  if (response.IsTruncated === true && contents.length === 0) fail();
  if (requireComplete && response.IsTruncated === true) fail();

  if (requireComplete && Object.hasOwn(response, "NextContinuationToken")) fail();

  process.stdout.write(`${contents.length}\n`);
} catch {
  process.stderr.write("Could not classify object inventory\n");
  process.exitCode = 1;
}
