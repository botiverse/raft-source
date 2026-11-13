// Platform entry point: people's Activity rows for an app's objects (S6,
// first-party app mechanism §四). Core keeps one row per (person, object)
// from the object events' recipients (recordObjectEvent writes it); what an
// app adds through here:
// - markObjectRead: a person's read position on one of its objects moved
//   (opened, marked read), reported in the transaction that moves it, so
//   Activity and its badge know what is unread without asking the app;
// - forgetObjectActivity: an object nobody may see any more (deleted), in
//   the deleting transaction, or that some people may no longer see (moved
//   to a smaller home: only their rows, objectActivityPeople listing whose
//   rows there are), in the moving one; after the commit,
//   announceActivityChanged tells the people whose rows went;
// - announceObjectEvents: after the commit of a transaction that recorded
//   object events, tell their recipients' clients that Activity changed
//   (`activity:changed`).
export { forgetObjectActivity, markObjectRead, objectActivityPeople, type ForgottenActivityRow, type ObjectReadThrough } from "../services/objectInboxStates";
export { announceActivityChanged, announceForgottenRows, announceObjectEvents } from "../services/activityRealtime";
