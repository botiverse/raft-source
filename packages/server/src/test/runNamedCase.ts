export async function runNamedCase(
  name: string,
  body: () => Promise<void>,
): Promise<void> {
  try {
    await body();
  } catch (cause) {
    throw new Error(`case failed: ${name}`, { cause });
  }
}
