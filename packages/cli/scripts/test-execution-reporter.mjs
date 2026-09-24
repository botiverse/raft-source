export default async function* testExecutionReporter(source) {
  for await (const event of source) {
    if ((event.type !== "test:pass" && event.type !== "test:fail") || event.data?.details?.type !== "test") {
      continue;
    }

    const data = event.data;
    yield `${JSON.stringify({
      type: event.type,
      file: data.file ?? data.entryFile ?? null,
      entryFile: data.entryFile ?? null,
      name: data.name,
      line: data.line ?? null,
      column: data.column ?? null,
      nesting: data.nesting ?? null,
      testId: data.testId ?? null,
      parentId: data.parentId ?? null,
      skip: data.skip ?? null,
      todo: data.todo ?? null,
    })}\n`;
  }
}
