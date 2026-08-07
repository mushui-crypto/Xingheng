import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  providerUserStreamProbeConnectivityFailureDetail,
  providerUserStreamProbeErrorCategory,
  providerUserStreamProbeFailureStage,
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

class SilentSocket extends EventEmitter {
  close() {}
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

test("provider stream probe maps failures to five redacted diagnostic stages", async () => {
  const cases = [
    {
      expected: "connectivity_failed",
      run: () => captureProbeFailure((url) => {
        const socket = new Socket(url);
        if (url.includes("fstream")) setTimeout(() => socket.emit("close"), 1);
        return socket;
      }),
    },
    {
      expected: "auth_handshake_failed",
      run: () => captureProbeFailure((url) => {
        class RejectedSpot extends Socket {
          override send(value: string) {
            const request = JSON.parse(value);
            queueMicrotask(() => this.emit("message", JSON.stringify({ id: request.id, status: 401 })));
          }
        }
        return url.includes("ws-api") ? new RejectedSpot(url) : new Socket(url);
      }),
    },
    {
      expected: "subscription_failed",
      run: () => captureProbeFailure((url) => {
        const socket = new Socket(url);
        if (url.includes("fstream")) {
          setTimeout(() => socket.emit("message", JSON.stringify({ e: "UNKNOWN_EVENT" })), 1);
        }
        return socket;
      }),
    },
    {
      expected: "no_stream_data",
      run: () => captureProbeFailure(() => new SilentSocket() as Socket, fetchFixture([]), {
        timeoutMs: 10,
        observationMs: 5,
      }),
    },
    {
      expected: "heartbeat_timeout",
      run: () => captureProbeFailure(
        (url) => new Socket(url),
        (async (_url: string, init?: RequestInit) => new Response(
          init?.method === "POST" ? JSON.stringify({ listenKey: "listen-key" }) : "{}",
          { status: init?.method === "PUT" ? 500 : 200 },
        )) as typeof fetch,
      ),
    },
  ] as const;

  for (const item of cases) {
    const error = await item.run();
    assert.equal(providerUserStreamProbeFailureStage(error), item.expected);
    assert.doesNotMatch(String(error), /fixture-key|fixture-secret|private UID/u);
  }
});

test("provider stream probe maps connectivity errors to four redacted details", async () => {
  const cases = [
    ["ENOTFOUND", "dns_resolution_failed"],
    ["ECONNREFUSED", "tcp_connection_failed"],
    ["ERR_TLS_CERT_ALTNAME_INVALID", "tls_handshake_failed"],
    ["ERR_INVALID_URL", "endpoint_configuration_missing"],
  ] as const;
  for (const [code, expected] of cases) {
    const error = Object.assign(new Error("raw endpoint and credential detail"), { code });
    assert.equal(providerUserStreamProbeConnectivityFailureDetail(error), expected);
  }
  assert.equal(
    providerUserStreamProbeConnectivityFailureDetail(new Error("unknown raw failure")),
    null,
  );
  assert.equal(providerUserStreamProbeConnectivityFailureDetail(Object.defineProperty({}, "code", {
    get() { throw new Error("raw getter failure"); },
  })), null);
});

test("provider stream close retains only the redacted TCP detail", async () => {
  const error = await captureProbeFailure((url) => {
    const socket = new Socket(url);
    if (url.includes("fstream")) setTimeout(() => socket.emit("close"), 1);
    return socket;
  });
  assert.equal(providerUserStreamProbeFailureStage(error), "connectivity_failed");
  assert.equal(
    providerUserStreamProbeConnectivityFailureDetail(error),
    "tcp_connection_failed",
  );
});

async function captureProbeFailure(
  socketFactory: (url: string) => Socket,
  fetchFn: typeof fetch = fetchFixture([]),
  timing = bounds,
) {
  try {
    await runRwaProviderUserStreamProbe(
      credentials,
      fetchFn,
      ((url: string) => socketFactory(url) as any),
      Date.now,
      timing,
    );
  } catch (error) {
    return error;
  }
  throw new Error("expected stream probe failure");
}

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
