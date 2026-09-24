import {
  createRaftChannelRefRegex,
  createRaftChannelThreadRefRegex,
  createRaftDmRefRegex,
  createRaftDmThreadRefRegex,
  RAFT_REF_CHANNEL_NAME_PATTERN,
  RAFT_REF_DM_PEER_PATTERN,
  RAFT_REF_THREAD_SHORT_ID_PATTERN,
} from "@botiverse/raft-shared";

// Web compatibility wrapper. Raft Ref grammar lives in @botiverse/raft-shared
// (`raftRefs`) so server mention extraction and web rendering cannot drift.

export const CHANNEL_REF_NAME_PATTERN = RAFT_REF_CHANNEL_NAME_PATTERN;
export const THREAD_SHORT_ID_PATTERN = RAFT_REF_THREAD_SHORT_ID_PATTERN;
export const DM_REF_PEER_PATTERN = RAFT_REF_DM_PEER_PATTERN;

export function createChannelThreadRefRegex(): RegExp {
  return createRaftChannelThreadRefRegex();
}

export function createChannelRefRegex(): RegExp {
  return createRaftChannelRefRegex();
}

export function createDmThreadRefRegex(): RegExp {
  return createRaftDmThreadRefRegex();
}

export function createDmRefRegex(): RegExp {
  return createRaftDmRefRegex();
}
