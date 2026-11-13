// The users-first lock rule (lockJointUsersFirst, jointHumanMembershipMirror.ts):
// the transaction entry points held to it, and the tables whose writes make a
// transaction subject to it. Shared by the run-time guard
// (services/jointUsersFirstLockOrder.realPg.test.ts) and the static reverse
// coverage check (services/jointUsersFirstWriters.contract.test.ts).

/** Entry point id -> what it is. Each id has a scenario in the real-PG guard's ENTRY_POINTS. */
export const JOINT_USERS_FIRST_ENTRY_POINTS = {
  yourServersJoint: "Your servers on a joint channel (connectOwnServersToChannel -> createDirectConnectInvite, connectJointChannel)",
  yourServersPrivate: "Your servers on a private channel (connectOwnServersToChannel -> reserveConnection)",
  connectWorker: "connect worker after a reservation (advanceExternalConnect -> connectJointChannel)",
  emailedInviteConnect: "connect with an emailed invite (connectServerWithInvite -> connectJointChannel)",
  requestApproval: "ask an admin to approve a connection (requestServerConnectApproval -> createApprovalRequests)",
  selfConnect: "self_connect (connectMyServersToChannel -> createSelfConnectInvite, selfConnectInTransaction)",
  guestAccept: "Guest accept (acceptExternalInviteAsGuest)",
  hostDisconnect: "host disconnect (disconnectParticipantServerByHost)",
  selfDisconnect: "self disconnect (disconnectJointChannel)",
  removeMemberByAdmin: "member removed from a server (removeMember, by an admin)",
  removeMemberLeave: "member leaving a server (removeMember)",
  convertToJoint: "a conversion command (admitConversionCommand, executeConversionCommand -> startChannelToJointConversion); its old route, POST /channels/:id/convert-to-joint, is retired",
  sendExternalInvites: "Invite People Outside (sendExternalInvites -> insertExternalInvites)",
  createJointChannel: "creating a joint channel (createJointChannel -> createJointChannelInTransaction)",
  resendJointInvites: "POST /channels/:id/joint-invite/resend (resendPendingJointChannelInvites)",
  deleteChannel: "deleting a channel with a bound Guest (deleteChannel -> deleteChannelInTransaction)",
  roleTransition: "a server role change (transitionMemberRole -> transitionMemberRoleInTransaction)",
  mentionAdd: "a mention action adding a person to a channel (executeMentionActionId -> executeMentionActionForRow)",
  conversionFinalize: "the conversion worker's audience cutover and finalize (runChannelConversionJob -> audienceCutover, finalize)",
  resendExternalInvite: "resending an emailed invite (resendExternalInvite -> insertExternalInvites)",
  revokeExternalInvite: "revoking an invite (revokeExternalInvite -> revokeLockedInvite)",
  channelAddHuman: "a channel admin adds a person to a joint channel (withLockedChannelActorCapability -> addHuman)",
  channelRemoveHuman: "a channel admin removes a person from a joint channel (withLockedChannelActorCapability -> removeHuman)",
  channelLeave: "a person leaving a joint channel (removeHuman in its own transaction, { self: true })",
  archiveChannel: "archiving a channel with a bound Guest and an open invite (POST /channels/:id/archive: withLockedChannelActorCapability -> archiveChannel)",
  inviteServerToJoint: "POST /channels/:id/joint-invites (inviteServerToJointChannel)",
  approveConnectRequest: "an approver approving a connect request (approveServerConnectRequest -> connectJointChannel)",
} as const;
export type JointUsersFirstEntryPoint = keyof typeof JOINT_USERS_FIRST_ENTRY_POINTS;

/**
 * Known exceptions: paths that change joint membership but do not take the
 * users rows first yet. Each has an expected-failure scenario in the guard
 * (test.fails), which turns red once the path is fixed: then move it to
 * JOINT_USERS_FIRST_ENTRY_POINTS.
 */
export const JOINT_USERS_FIRST_KNOWN_EXCEPTIONS = {} as const;
export type JointUsersFirstKnownException = keyof typeof JOINT_USERS_FIRST_KNOWN_EXCEPTIONS;

/**
 * Joint membership and connection tables (drizzle name -> SQL name, and the
 * columns with a foreign key to users). A transaction writing one is subject
 * to the rule. `channel_external_invites` counts for inserts only in the
 * run-time guard: its status updates (lapse, settle) name no new user.
 */
export const JOINT_WRITE_TABLES = {
  jointChannelServers: { sqlName: "joint_channel_servers", usersFk: ["joinedByUserId", "disconnectedByUserId"] },
  jointChannelMembers: { sqlName: "joint_channel_members", usersFk: ["userId"] },
  jointChannelAdmissions: { sqlName: "joint_channel_admissions", usersFk: ["userId", "admittedBy"] },
  jointChannelInvites: { sqlName: "joint_channel_invites", usersFk: ["invitedUserId", "invitedByUserId", "acceptedByUserId"] },
  jointMembershipDepartures: { sqlName: "joint_membership_departures", usersFk: ["actorUserId"] },
  channelHumans: { sqlName: "channel_humans", usersFk: ["userId"] },
  serverMembers: { sqlName: "server_members", usersFk: ["userId"] },
  serverMembershipDepartures: { sqlName: "server_membership_departures", usersFk: ["userId", "actorUserId"] },
  channelConversionJobs: { sqlName: "channel_conversion_jobs", usersFk: ["createdByUserId"] },
  channelExternalInvites: { sqlName: "channel_external_invites", usersFk: ["invitedByUserId", "acceptedUserId", "revokedByUserId", "connectJoinerUserId", "connectAuthorizerUserId"], insertsOnly: true },
  channelServerConnectRequests: { sqlName: "channel_server_connect_requests", usersFk: ["requesterUserId", "approverUserId"], insertsOnly: true },
} as const satisfies Record<string, { sqlName: string; usersFk: readonly string[]; insertsOnly?: true }>;
