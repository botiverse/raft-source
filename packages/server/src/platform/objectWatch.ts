// Platform entry point: pages watching an app's object live (shared
// objectWatch.ts). Core joins a watching socket to the object's rooms only
// after the app's own read rule let its person read it (AppObjectKind.watch,
// asked by socket/objectWatch.ts); what an app adds through here:
// - announceObjectChanged: after the commit of a change to one part of an
//   object (its comments, a new version), a content-free `object:changed` to
//   that part's watchers, so their pages read it again;
// - forgetObjectWatchers: after the commit that deleted an object or moved it
//   to a smaller home, every socket leaves its rooms (a page still open is
//   checked again when it next watches).
export { announceObjectChanged, forgetObjectWatchers } from "../services/objectWatchRealtime";
