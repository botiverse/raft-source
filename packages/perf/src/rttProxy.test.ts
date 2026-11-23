import net from "node:net";
import type { AddressInfo } from "node:net";
import { RTT_RANGE_MS, connectTarget, rttChromiumArgs, startRttProxy } from "./rttProxy";

/** An echo server on loopback, and one round trip through the proxy to it: CONNECT, then send "ping", wait for the echo. */
async function roundTrip(proxyUrl: string): Promise<{ ms: number; connectMs: number; echoed: string }> {
  const echo = net.createServer((s) => s.pipe(s));
  await new Promise<void>((resolve) => echo.listen(0, "127.0.0.1", resolve));
  const echoPort = (echo.address() as AddressInfo).port;
  const proxy = new URL(proxyUrl);
  try {
    const socket = net.connect(Number(proxy.port), proxy.hostname);
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    const asked = Date.now();
    socket.write(`CONNECT 127.0.0.1:${echoPort} HTTP/1.1\r\nHost: 127.0.0.1:${echoPort}\r\n\r\n`);
    await new Promise<void>((resolve) => socket.once("data", () => resolve()));
    const connectMs = Date.now() - asked;
    const start = Date.now();
    socket.write("ping");
    const echoed = await new Promise<string>((resolve) => socket.once("data", (b: Buffer) => resolve(b.toString())));
    const ms = Date.now() - start;
    socket.destroy();
    return { ms, connectMs, echoed };
  } finally {
    echo.close();
  }
}

describe("startRttProxy", () => {
  it("adds about the round trip it was given to one exchange through it", async () => {
    const proxy = await startRttProxy(200);
    try {
      const { ms, connectMs, echoed } = await roundTrip(proxy.url);
      expect(echoed).toBe("ping");
      // the tunnel answers after one round trip (the TCP handshake), then each exchange pays one
      expect(connectMs).toBeGreaterThanOrEqual(195);
      expect(ms).toBeGreaterThanOrEqual(195);
      expect(ms).toBeLessThan(600);
      expect(proxy.tunnels()).toBe(1);
    } finally {
      await proxy.close();
    }
  });
  it("adds nothing measurable at 0", async () => {
    const proxy = await startRttProxy(0);
    try {
      const { ms, echoed } = await roundTrip(proxy.url);
      expect(echoed).toBe("ping");
      expect(ms).toBeLessThan(100);
    } finally {
      await proxy.close();
    }
  });
  it("refuses a round trip outside its range", async () => {
    await expect(startRttProxy(-1)).rejects.toThrow(RangeError);
    await expect(startRttProxy(RTT_RANGE_MS[1] + 1)).rejects.toThrow(RangeError);
    await expect(startRttProxy(Number.NaN)).rejects.toThrow(RangeError);
  });
  it("routes loopback through the proxy too", () => {
    expect(rttChromiumArgs({ url: "http://127.0.0.1:9" })).toEqual(["--proxy-server=http://127.0.0.1:9", "--proxy-bypass-list=<-loopback>"]);
  });
  it("passes a whole answer through before a clean close (nothing cut off at the end)", async () => {
    const body = "x".repeat(200_000);
    const server = net.createServer((s) => s.end(body));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const proxy = await startRttProxy(40);
    try {
      const p = new URL(proxy.url);
      const socket = net.connect(Number(p.port), p.hostname);
      await new Promise<void>((resolve) => socket.once("connect", resolve));
      socket.write(`CONNECT 127.0.0.1:${port} HTTP/1.1\r\n\r\n`);
      const got = await new Promise<string>((resolve) => {
        let all = "";
        socket.on("data", (b: Buffer) => (all += b.toString()));
        socket.on("end", () => resolve(all));
      });
      expect(got.endsWith(body)).toBe(true);
      expect(got.startsWith("HTTP/1.1 200")).toBe(true);
    } finally {
      await proxy.close();
      server.close();
    }
  });
  it("answers 502 when the target refuses the connection, and 400 for a target it cannot read", async () => {
    const closed = net.createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const deadPort = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const proxy = await startRttProxy(0);
    try {
      const ask = async (line: string): Promise<string> => {
        const p = new URL(proxy.url);
        const socket = net.connect(Number(p.port), p.hostname);
        await new Promise<void>((resolve) => socket.once("connect", resolve));
        socket.write(`CONNECT ${line} HTTP/1.1\r\n\r\n`);
        return new Promise<string>((resolve) => {
          let all = "";
          socket.on("data", (b: Buffer) => (all += b.toString()));
          socket.on("close", () => resolve(all));
        });
      };
      expect(await ask(`127.0.0.1:${deadPort}`)).toMatch(/^HTTP\/1\.1 502/);
      expect(await ask("no-port-here")).toMatch(/^HTTP\/1\.1 400/);
    } finally {
      await proxy.close();
    }
  });
});

describe("connectTarget", () => {
  it("keeps port 80 and unwraps IPv6", () => {
    expect(connectTarget("example.com:80")).toEqual({ host: "example.com", port: 80 });
    expect(connectTarget("[::1]:443")).toEqual({ host: "::1", port: 443 });
    expect(connectTarget("api.raft.build:443")).toEqual({ host: "api.raft.build", port: 443 });
  });
  it("refuses what is not host:port", () => {
    expect(connectTarget(undefined)).toBeNull();
    expect(connectTarget("example.com")).toBeNull();
    expect(connectTarget(":443")).toBeNull();
    expect(connectTarget("example.com:0")).toBeNull();
    expect(connectTarget("example.com:99999")).toBeNull();
  });
});
