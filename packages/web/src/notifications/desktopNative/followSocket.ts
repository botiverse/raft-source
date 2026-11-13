// The app's socket is replaced, not reconnected, on login, logout and every
// MainLayout boot (api/socket.ts resetSocket: removeAllListeners, then a new
// instance). A listener attached once to the socket seen at mount is gone after
// that, so everything here attaches through followSocket: to the current
// socket and to each one that replaces it.

export interface EventSocketLike {
  /** Socket.IO's id (the server's socket id too); absent on fakes. */
  readonly id?: string;
  on(event: string, handler: (...args: unknown[]) => void): unknown;
  off(event: string, handler: (...args: unknown[]) => void): unknown;
}

export interface SocketSource<S> {
  current(): S;
  /** Calls `listener` with each new instance that replaces the current one. Returns unsubscribe. */
  onReplaced(listener: (socket: S) => void): () => void;
}

export interface NotificationSocket {
  readonly connected: boolean;
  emit(event: string, payload: unknown): unknown;
  on(event: string, handler: (...args: unknown[]) => void): unknown;
  off(event: string, handler: (...args: unknown[]) => void): unknown;
}

/**
 * Runs `attach` on the current socket and again on every replacement.
 * `attach` returns its detach; the returned disposer detaches from the
 * latest socket and stops following.
 */
export function followSocket<S>(source: SocketSource<S>, attach: (socket: S) => () => void): () => void {
  let detach = attach(source.current());
  const stop = source.onReplaced((socket) => {
    // The replaced instance already dropped every listener; detaching is
    // harmless and releases it.
    detach();
    detach = attach(socket);
  });
  return () => {
    stop();
    detach();
  };
}

/** Listens for `event` on the current socket and every replacement. */
export function listenOnEverySocket<S extends EventSocketLike>(
  source: SocketSource<S>,
  event: string,
  handler: (...args: unknown[]) => void,
): () => void {
  return followSocket(source, (socket) => {
    socket.on(event, handler);
    return () => { socket.off(event, handler); };
  });
}
