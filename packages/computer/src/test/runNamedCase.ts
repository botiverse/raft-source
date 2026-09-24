export async function runNamedCase(
  name: string,
  body: () => void | Promise<void>,
): Promise<void> {
  try {
    await body();
  } catch (cause) {
    throw new Error(`case failed: ${name}`, { cause });
  }
}
