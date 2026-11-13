// Create Agent with no computer yet: what the banner says and what its
// button does. In a browser: connect a computer (the command flow). On Raft
// Desktop that can add this Mac: "Add this Mac so agents can run here" and
// Add to This Server, which starts the one Add This Mac flow.
import type { MessageId } from "../../i18n/messages";
import { useLocalComputerHost } from "../../components/machine/localComputer/useLocalComputerHost";

export interface NeedsComputerCopy {
  title: MessageId;
  description: MessageId;
  action: MessageId;
}

export function useNeedsComputerCopy(browserDescription: MessageId): NeedsComputerCopy {
  const host = useLocalComputerHost();
  if (host && host.ready && host.canAttach) {
    const mac = host.self.deviceKind === "mac";
    return {
      title: mac ? "agent.create.addThisMacTitleMac" : "agent.create.addThisMacTitleOther",
      description: mac ? "agent.create.addThisMacBodyMac" : "agent.create.addThisMacBodyOther",
      action: "computerHost.thisDevice.addToServer",
    };
  }
  return { title: "agent.create.connectComputerFirst", description: browserDescription, action: "agent.create.connectComputer" };
}
