import { withComputerMutationLock } from "../concurrency.js";
import { ComputerError } from "../lib/errors.js";

const slockHome = process.argv[2];
if (!slockHome) throw new Error("missing SLOCK_HOME fixture argument");

try {
  await withComputerMutationLock(
    slockHome,
    async (signal) => {
      process.stdout.write("LOCK_HELD\n");
      await new Promise<void>((_resolve, reject) => {
        process.stdin.resume();
        signal?.addEventListener(
          "abort",
          () => {
            process.stdin.destroy();
            reject(signal.reason);
          },
          { once: true },
        );
      });
    },
    { staleMs: 2_000, updateMs: 1_000 },
  );
  process.stdout.write("UNEXPECTED_SUCCESS\n");
  process.exitCode = 24;
} catch (error) {
  if (error instanceof ComputerError) {
    process.stdout.write(`TYPED_ERROR ${error.code} ${error.message}\n`);
    process.exitCode = 23;
  } else {
    throw error;
  }
}
