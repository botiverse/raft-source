// The web app's shared socket (api/socket.ts) as a SocketSource: the current
// instance, and each one that replaces it.

import { getSocket, onSocketCreated } from "../../api/socket";
import type { NotificationSocket, SocketSource } from "./followSocket";

export const appSocketSource: SocketSource<NotificationSocket> = {
  current: () => getSocket(),
  onReplaced: (listener) => onSocketCreated(listener),
};
