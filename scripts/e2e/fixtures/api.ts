// Isolated collector contract fixture. Never run against a shared test server.
import { createServer } from "node:http";
import { evidenceConfig, observeApiProcess } from "../transportEvidence.js";

const observe = process.env.FIXTURE_OBSERVE === "off" ? undefined : observeApiProcess(evidenceConfig());
let requests = 0;
const server = createServer((request, response) => {
  requests++;
  const mode = process.env.FIXTURE_MODE;
  if (mode === "reset" || (mode === "reset-once" && requests === 1)) {
    request.socket.resetAndDestroy();
  } else if (mode === "close") {
    server.close();
    server.closeAllConnections();
  } else {
    request.resume();
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ accessToken: "SECRET_RESPONSE_TOKEN", refreshToken: "SECRET_REFRESH_TOKEN" }));
  }
});
observe?.(server);
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (address && typeof address === "object") process.send?.({ port: address.port });
});
process.on("message", (message) => {
  if (message === "close") {
    server.close(() => { process.exit(0); });
    server.closeAllConnections();
  }
  if (message === "unhandled-error") server.emit("error", new Error("SECRET_EXCEPTION_TEXT"));
});
