export type ReplacementHandoffRequest = (
  expectedComputerVersion?: string,
  beforeCommitExit?: () => Promise<void>,
) => void | Promise<void>;

export interface ReplacementHandoff {
  request(
    expectedComputerVersion?: string,
    beforeCommitExit?: () => Promise<void>,
  ): Promise<void>;
  requested(): boolean;
}

export function createReplacementHandoff(
  request: ReplacementHandoffRequest,
): ReplacementHandoff {
  let completed = false;
  return {
    request: async (expectedComputerVersion, beforeCommitExit) => {
      await request(expectedComputerVersion, beforeCommitExit);
      completed = true;
    },
    requested: () => completed,
  };
}
