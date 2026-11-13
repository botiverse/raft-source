// Handshake rejection messages the web client acts on. The server's socket
// auth middleware passes these to `next(new Error(...))`, and socket.io-client
// surfaces them verbatim as the `connect_error` message.

/** The user is signed in but no longer belongs to the requested server. */
export const SOCKET_NOT_SERVER_MEMBER_ERROR = "Not a member of this server";
/** The Server requires its single sign-on and this session was not signed in by it (RFC 083 §6.2). */
export const SOCKET_SSO_REQUIRED_ERROR = "SSO_REQUIRED";
