// The owner's notes for their personal assistant (RFC 077, #10762): the Server
// refuses longer notes and the web's editor checks the same limit as you type.

/** The longest owner's notes Raft keeps, in UTF-16 code units after trimming. */
export const ASSISTANT_OWNER_NOTES_MAX_LENGTH = 4000;
