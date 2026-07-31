import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  providerUserStreamProbeErrorCategory,
  runRwaProviderUserStreamProbe,
} from "./RwaProviderUserStreamProbe";

class Socket extends EventEmitter {
  closeCount = 0;
  constructor(readonly url: string) { super(); queueMicrotask(() => this.emit("open")); }
  send(value: string) {
    const request = JSON.parse(value);
    queueMicrotask(() => this.emit("message", JSON.stringify({ id: request.id, status: 200 })));
  }
  close() { this.closeCount += 1; this.emit("close"); }
}

const credentials = { apiKey: "key", apiSecret: "secret" };
const bounds = { timeoutMs: 50, observationMs: 5 };

test("provider stream probe observes both streams before completing the bounded session lifecycle", async () => {
  const methods: string[] = [];
  const sockets: Socket[] = [];
  const receipt = await runRwaProviderUserStreamProbe(
    credentials,
    fetchFixture(methods),
    ((url: string) => {
      const socket = new Socket(url);
      sockets.push(socket);
      return socket as any;
    }),
    () => 123,
    bounds,
  );
  assert.deepEqual(methods, ["POST", "PUT", "DELETE"]);
  assert.equal(sockets.length, 2);
  assert.ok(sockets.every((socket) => socket.closeCount === 1));
  assert.deepEqual(receipt, {
    spotSignedSubscribe: true,
    futuresListenKeyCreate: true,
    futuresListenKeyKeepalive: true,
    futuresListenKeyClose: true,
  });
});

test("provider stream probe fails stably on Spot close and cleans up", async () => {
  class SpotClose extends Socket {
    override send(value: string) {
      super.send(value);
      setTimeout(() => this.emit("close"), 1);
    }
  }
  await assertProbeFailure("spot_stream_closed", (url) =>
    url.includes("ws-api") ? new SpotClose(url) : new Socket(url));
});

test("provider stream probe fails stably on Futures close and cleans up", async () => {
  await assertProbeFailure("futures_stream_closed", (url) => {
    const socket = new Socket(url);
    if (url.includes("fstream")) setTimeout(() => socket.emit("close"), 1);
    return socket;
  });
});

test("provider stream probe fails stably on Futures listenKey expiry and cleans up", async () => {
  await assertProbeFailure("futures_listen_key_expired", (url) => {
    const socket = new Socket(url);
    if (url.includes("fstream")) {
      setTimeout(() => socket.emit("message", JSON.stringify({ e: "listenKeyExpired" })), 1);
    }
    return socket;
  });
});

test("provider stream probe fails stably on an unknown Futures payload and cleans up", async () => {
  await assertProbeFailure("futures_stream_unknown_payload", (url) => {
    const socket = new Socket(url);
    if (url.includes("fstream")) {
      setTimeout(() => socket.emit("message", JSON.stringify({ e: "UNKNOWN_EVENT" })), 1);
    }
    return socket;
  });
});

test("provider stream probe bounds a cleanup DELETE that never settles and preserves the original failure", async () => {
  const methods: string[] = [];
  const sockets: Socket[] = [];
  class RejectedSpot extends Socket {
    override send(value: string) {
      const request = JSON.parse(value);
      queueMicrotask(() => this.emit("message", JSON.stringify({ id: request.id, status: 400 })));
    }
  }
  const started = Date.now();
  await assert.rejects(
    runRwaProviderUserStreamProbe(
      credentials,
      (async (_url: string, init?: RequestInit) => {
        methods.push(String(init?.method));
        if (init?.method === "DELETE") return new Promise<Response>(() => {});
        return new Response(JSON.stringify({ listenKey: "listen-key" }), { status: 200 });
      }) as typeof fetch,
      ((url: string) => {
        const socket = url.includes("ws-api") ? new RejectedSpot(url) : new Socket(url);
        sockets.push(socket);
        return socket as any;
      }),
      Date.now,
      { timeoutMs: 20, observationMs: 5 },
    ),
    (error: unknown) => providerUserStreamProbeErrorCategory(error) === "spot_subscribe_ack_invalid",
  );
  assert.ok(Date.now() - started < 200);
  assert.deepEqual(methods, ["POST", "DELETE"]);
  assert.ok(sockets.every((socket) => socket.closeCount === 1));
});

async function assertProbeFailure(category: string, socketFactory: (url: string) => Socket) {
  const methods: string[] = [];
  const sockets: Socket[] = [];
  await assert.rejects(
    runRwaProviderUserStreamProbe(
      credentials,
      fetchFixture(methods),
      ((url: string) => {
        const socket = socketFactory(url);
        sockets.push(socket);
        return socket as any;
      }),
      Date.now,
      bounds,
    ),
    (error: unknown) => providerUserStreamProbeErrorCategory(error) === category,
  );
  assert.deepEqual(methods, ["POST", "DELETE"]);
  assert.ok(sockets.every((socket) => socket.closeCount === 1));
}

function fetchFixture(methods: string[]) {
  return (async (_url: string, init?: RequestInit) => {
    methods.push(String(init?.method));
    return new Response(init?.method === "POST" ? JSON.stringify({ listenKey: "listen-key" }) : "{}", {
      status: 200,
    });
  }) as typeof fetch;
}
