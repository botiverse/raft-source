import {
  ensureSocketConnected,
  getSocket,
  isSocketConnected,
  reconnectSocket,
} from "../api/socket";
import { createMainLayoutRealtimeBridgeDriver } from "./socketBridge";

export const mainLayoutRealtimeBridgeDriver = createMainLayoutRealtimeBridgeDriver({
  getSocket,
  reconnectSocket,
  ensureSocketConnected,
  isSocketConnected,
});
