// Platform entry point: the platform's objects. The write side of
// `object_events` and `object_event_recipients` (recordObjectEvent), which an
// app calls in its own transaction for each change to one of its objects: its
// registered kind and event kind, the object's home after the change (and
// before, when it moved), and whom the event is for; forgetObjectEvents
// removes one object's events for good, for an app purging it. Reads of an app's
// objects go through `POST /api/objects/summaries`, where core filters by
// the homes the kind's registration reports before the app's summarize.
export {
  forgetObjectEvents,
  ObjectEventRejected,
  recordObjectEvent,
  type ObjectEventHome,
  type ObjectEventInput,
  type ObjectEventRecipient,
  type ObjectEventRecipientReason,
} from "../services/objectEvents";
