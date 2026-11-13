// Platform entry point: channel announcements (#proj-chat:#29, flag
// channel_announcement_v0). A channel's announcement is one object homed in
// it, of the kind that declares `channelAnnouncement` (AppObjectKind); core
// stores which (channels.announcement_artifact_id) and decides who may set it
// (services/channelAnnouncements.ts). The app owning the object asks here,
// in its own transaction:
//
// - which agents to tell when the object gets a new version: the agent
//   members of each live channel that has it as its announcement, with the
//   flag on for that channel's server, each once, with the channel as it
//   names it (`channelAnnouncementAudience`); who may see the object is
//   still the app's check;
// - whether an actor may push a new version of the object: while it is a
//   live channel's announcement, only one who may set that channel's
//   announcement (editChannelMetadata) may (`channelAnnouncementPushRefusal`);
// - that the object left its home (deleted, moved out), so no channel keeps
//   it as its announcement (`clearChannelAnnouncementsOf`). Reads check the
//   home again anyway, so a missed clear never shows a stale announcement.
//
// A joint has an announcement only while every server sharing it has the
// flag (and the object's app) on: with one side off, both functions above
// answer as for no announcement.
//
// Channels, their rosters, joints and the flag are core's.
export { channelAnnouncementAudience, channelAnnouncementPushRefusal, clearChannelAnnouncementsOf } from "../services/channelAnnouncements";
