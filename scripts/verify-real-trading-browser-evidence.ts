import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import WebSocket from "ws";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const chromeBin = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const widths = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
  { width: 430, height: 932 },
  { width: 480, height: 900 },
];

type CdpMessage = { id?: number; method?: string; params?: unknown; result?: unknown; error?: { message: string }; };

type BrowserEvidence = {
  width: number;
  btcConfirm: ModalSnapshot;
  afterSwitch: ResetSnapshot;
  dogeInvalid: ErrorSnapshot;
  dogeConfirm: ModalSnapshot;
};

type ModalSnapshot = {
  modalOpen: boolean;
  signerCalls: number;
  summaryText: string;
  modalRect: { left: number; right: number; width: number } | null;
  documentWidth: number;
  viewportWidth: number;
};

type ResetSnapshot = {
  modalOpen: boolean;
  price: string;
  size: string;
  tpPrice: string;
  slPrice: string;
  percent: string;
  message: string;
  signerCalls: number;
};

type ErrorSnapshot = {
  modalOpen: boolean;
  message: string;
  signerCalls: number;
};

class CdpClient {
  #id = 0;
  #pending = new Map<number, { reject: (error: Error) => void; resolve: (value: any) => void }>();
  #events = new Map<string, Array<(params: any) => void>>();

  constructor(private ws: WebSocket) {
    ws.on("message", (raw) => {
      const message = JSON.parse(String(raw)) as CdpMessage;
      if (message.id) {
        const pending = this.#pending.get(message.id);
        if (!pending) return;
        this.#pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
        return;
      }
      if (message.method) {
        for (const handler of this.#events.get(message.method) ?? []) handler(message.params);
      }
    });
  }

  send<T = any>(method: string, params: Record<string, unknown> = {}) {
    const id = ++this.#id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
  }

  once(method: string) {
    return new Promise<any>((resolve) => {
      const handler = (params: any) => {
        const handlers = this.#events.get(method) ?? [];
        this.#events.set(method, handlers.filter((item) => item !== handler));
        resolve(params);
      };
      this.#events.set(method, [...(this.#events.get(method) ?? []), handler]);
    });
  }

  async evaluate<T>(expression: string) {
    const result = await this.send<{ exceptionDetails?: unknown; result: { value: T } }>("Runtime.evaluate", {
      awaitPromise: true,
      expression,
      returnByValue: true,
    });
    if (result.exceptionDetails) throw new Error(`browser evaluation failed: ${JSON.stringify(result.exceptionDetails)}`);
    return result.result.value;
  }
}

async function main() {
  const tempRoot = await mkdtemp(path.join(repoRoot, ".tmp-real-confirm-"));
  let vite: ViteDevServer | null = null;
  let chrome: ChildProcessWithoutNullStreams | null = null;
  let client: CdpClient | null = null;
  try {
    await writeHarness(tempRoot);
    vite = await createServer({
      configFile: false,
      plugins: [react()],
      root: tempRoot,
      server: { fs: { allow: [tempRoot, repoRoot] }, host: "127.0.0.1", port: 0, strictPort: false },
      resolve: { dedupe: ["react", "react-dom"] },
    });
    await vite.listen();
    const url = vite.resolvedUrls?.local[0];
    assert.ok(url, "Vite harness URL missing");

    const launched = await launchChrome();
    chrome = launched.chrome;
    const pageWsUrl = await createChromePage(launched.browserWsUrl, url);
    client = await connectPage(pageWsUrl);
    await client.send("Runtime.enable");
    await client.send("Page.enable");

    const evidence: BrowserEvidence[] = [];
    for (const size of widths) {
      await client.send("Emulation.setDeviceMetricsOverride", {
        deviceScaleFactor: 1,
        height: size.height,
        mobile: size.width < 600,
        width: size.width,
      });
      const load = client.once("Page.loadEventFired");
      await client.send("Page.navigate", { url });
      await load;
      await waitForHarness(client);
      evidence.push(await runScenario(client, size.width));
    }

    assert.equal(evidence.length, widths.length);
    for (const item of evidence) {
      assertModalSnapshot(item.btcConfirm, item.width, "BTC confirm");
      assert.equal(item.btcConfirm.signerCalls, 0, "opening BTC confirm must not call signer");
      assert.match(item.btcConfirm.summaryText, /BTCUSDT/);
      assert.match(item.btcConfirm.summaryText, /0\.12345 BTC/);

      assert.equal(item.afterSwitch.modalOpen, false, `DOGE switch must close confirm at ${item.width}px`);
      assert.deepEqual(
        [item.afterSwitch.price, item.afterSwitch.size, item.afterSwitch.tpPrice, item.afterSwitch.slPrice, item.afterSwitch.percent, item.afterSwitch.message],
        ["", "", "", "", "0", ""],
        `DOGE switch must clear order inputs and message at ${item.width}px`,
      );
      assert.equal(item.afterSwitch.signerCalls, 0, "market switch must not call signer");

      assert.equal(item.dogeInvalid.modalOpen, false, `invalid DOGE size must not open confirm at ${item.width}px`);
      assert.match(item.dogeInvalid.message, /DOGEUSDT 数量最多允许 0 位小数/);
      assert.equal(item.dogeInvalid.signerCalls, 0, "invalid DOGE size must not call signer");

      assertModalSnapshot(item.dogeConfirm, item.width, "DOGE confirm");
      assert.equal(item.dogeConfirm.signerCalls, 0, "opening DOGE confirm must not call signer");
      assert.match(item.dogeConfirm.summaryText, /DOGEUSDT/);
      assert.match(item.dogeConfirm.summaryText, /0\.071235 USDC/);
      assert.match(item.dogeConfirm.summaryText, /10 DOGE/);
    }

    console.log(JSON.stringify({ ok: true, widths: evidence.map(({ width }) => width), evidence }, null, 2));
  } finally {
    await client?.send("Browser.close").catch(() => undefined);
    chrome?.kill("SIGTERM");
    await vite?.close();
    await rm(tempRoot, { force: true, recursive: true });
  }
}

function assertModalSnapshot(snapshot: ModalSnapshot, width: number, label: string) {
  assert.equal(snapshot.modalOpen, true, `${label} should open at ${width}px`);
  assert.ok(snapshot.modalRect, `${label} modal rect missing at ${width}px`);
  assert.ok(snapshot.modalRect!.left >= 0, `${label} modal overflows left at ${width}px`);
  assert.ok(snapshot.modalRect!.right <= width, `${label} modal overflows right at ${width}px`);
  assert.ok(snapshot.documentWidth <= width, `${label} document overflows at ${width}px`);
}

async function writeHarness(tempRoot: string) {
  await writeFile(path.join(tempRoot, "index.html"), '<!doctype html><html><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><title>Real Trading Confirm Harness</title></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>');
  await mkdir(path.join(tempRoot, "src"), { recursive: true });
  const componentPath = path.join(repoRoot, "src/features/realTrading/components/RealTradingOrderPanel.tsx");
  const cssPath = path.join(repoRoot, "src/index.css");
  await writeFile(path.join(tempRoot, "src", "main.tsx"), `
import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import ${JSON.stringify(cssPath)};
import { RealTradingOrderPanel } from ${JSON.stringify(componentPath)};

const markets = {
  BTC: { assetId: 0, availableMargin: 10000, markPrice: 65000.12, positionSize: 0.5, szDecimals: 5, symbol: "BTCUSDT" },
  DOGE: { assetId: 12, availableMargin: 10000, markPrice: 0.07123456, positionSize: 1000, szDecimals: 0, symbol: "DOGEUSDT" },
};

function App() {
  const [marketKey, setMarketKey] = useState("BTC");
  const [message, setMessageState] = useState("");
  const [messageTone, setMessageTone] = useState("info");
  const market = markets[marketKey];

  useEffect(() => {
    window.__setMarket = (next) => setMarketKey(next);
    window.__calls = window.__calls ?? { placeOrder: 0, placeOrderWithTpsl: 0, updateLeverage: 0 };
  }, []);

  const signer = useMemo(() => ({
    async placeOrder(order) { window.__calls.placeOrder += 1; window.__calls.lastOrder = order; },
    async placeOrderWithTpsl(order, triggers) { window.__calls.placeOrderWithTpsl += 1; window.__calls.lastOrder = order; window.__calls.lastTriggers = triggers; },
    async updateLeverage() { window.__calls.updateLeverage += 1; },
  }), []);

  const session = useMemo(() => ({
    authorized: true,
    busy: false,
    message,
    messageTone,
    signer,
    setError(value) { setMessageTone("error"); setMessageState(value); },
    setMessage(value) { setMessageTone("info"); setMessageState(value); },
    async runAction(action, success) { await action(signer); setMessageTone("success"); setMessageState(success); return true; },
  }), [message, messageTone, signer]);

  return <main style={{ padding: 16 }}>
    <div id="harness-controls" style={{ display: "flex", gap: 8, marginBottom: 16 }}>
      <button id="switch-btc" type="button" onClick={() => setMarketKey("BTC")}>BTC</button>
      <button id="switch-doge" type="button" onClick={() => setMarketKey("DOGE")}>DOGE</button>
      <strong id="current-market">{market.symbol}</strong>
    </div>
    <RealTradingOrderPanel
      assetId={market.assetId}
      availableMargin={market.availableMargin}
      connected={true}
      fees={{ activeReferralDiscount: null, activeStakingDiscount: null, makerRate: 0.0002, network: "hyperliquid-testnet", spotMakerRate: null, spotTakerRate: null, takerRate: 0.0005, timestamp: Date.now() }}
      markPrice={market.markPrice}
      maxLeverage={20}
      onConnect={() => {}}
      onSubmitted={() => {}}
      positionSize={market.positionSize}
      session={session}
      szDecimals={market.szDecimals}
      symbol={market.symbol}
    />
  </main>;
}

createRoot(document.getElementById("root")).render(<App />);
window.__harnessReady = true;
`);
}

async function launchChrome() {
  const profile = await mkdtemp(path.join(tmpdir(), "stellax-chrome-"));
  const chrome = spawn(chromeBin, [
    "--headless=new",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "about:blank",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  const browserWsUrl = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for Chrome DevTools URL")), 15_000);
    chrome.stderr.on("data", (chunk) => {
      const match = String(chunk).match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    chrome.on("exit", (code) => reject(new Error(`Chrome exited early with ${code}`)));
  });
  chrome.on("exit", () => void rm(profile, { force: true, recursive: true }));
  return { browserWsUrl, chrome };
}

async function createChromePage(browserWsUrl: string, url: string) {
  const endpoint = new URL(browserWsUrl);
  const httpBase = `http://${endpoint.host}`;
  const response = await fetch(`${httpBase}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
  if (!response.ok) throw new Error(`Unable to create Chrome page: ${response.status}`);
  const page = await response.json() as { webSocketDebuggerUrl: string };
  return page.webSocketDebuggerUrl;
}

async function connectPage(pageWsUrl: string) {
  const ws = new WebSocket(pageWsUrl);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  return new CdpClient(ws);
}

async function waitForHarness(client: CdpClient) {
  for (let i = 0; i < 100; i += 1) {
    const ready = await client.evaluate<boolean>("Boolean(window.__harnessReady && document.querySelector('.xh-real-order-panel'))");
    if (ready) return;
    await delay(50);
  }
  throw new Error("Timed out waiting for real trading order panel harness");
}

async function runScenario(client: CdpClient, width: number): Promise<BrowserEvidence> {
  await client.evaluate(`window.__calls = { placeOrder: 0, placeOrderWithTpsl: 0, updateLeverage: 0 }; window.__setMarket('BTC');`);
  await delay(100);
  await fillLimitOrder(client, { price: "65000.123", size: "0.12345", sl: "60000", tp: "70000", tpsl: true });
  await clickButton(client, "买入 / 做多");
  await delay(100);
  const btcConfirm = await modalSnapshot(client);

  await client.evaluate(`window.__setMarket('DOGE')`);
  await delay(150);
  const afterSwitch = await resetSnapshot(client);

  await fillLimitOrder(client, { price: "0.07123456", size: "1.5", tpsl: false });
  await clickButton(client, "买入 / 做多");
  await delay(100);
  const dogeInvalid = await errorSnapshot(client);

  await fillLimitOrder(client, { price: "0.07123456", size: "10", tpsl: false });
  await clickButton(client, "买入 / 做多");
  await delay(100);
  const dogeConfirm = await modalSnapshot(client);

  return { afterSwitch, btcConfirm, dogeConfirm, dogeInvalid, width };
}

async function fillLimitOrder(client: CdpClient, values: { price: string; size: string; sl?: string; tp?: string; tpsl: boolean }) {
  await client.evaluate(`(${setInputByLabel.toString()})("价格", ${JSON.stringify(values.price)});`);
  await client.evaluate(`(${setInputByLabel.toString()})("数量", ${JSON.stringify(values.size)});`);
  const tpslChecked = await client.evaluate<boolean>(`Boolean([...document.querySelectorAll('label')].find((node) => node.textContent?.includes('止盈/止损'))?.querySelector('input')?.checked)`);
  if (tpslChecked !== values.tpsl) {
    await client.evaluate(`([...document.querySelectorAll('label')].find((node) => node.textContent?.includes('止盈/止损'))?.querySelector('input'))?.click()`);
    await delay(50);
  }
  if (values.tpsl) {
    await client.evaluate(`(${setInputByLabel.toString()})("止盈价", ${JSON.stringify(values.tp ?? "")});`);
    await client.evaluate(`(${setInputByLabel.toString()})("止损价", ${JSON.stringify(values.sl ?? "")});`);
  }
}

async function clickButton(client: CdpClient, text: string) {
  await client.evaluate(`([...document.querySelectorAll('button')].find((node) => node.textContent?.includes(${JSON.stringify(text)})))?.click()`);
}

function setInputByLabel(labelText: string, value: string) {
  const label = [...document.querySelectorAll("label")].find((node) => node.textContent?.includes(labelText));
  const input = label?.querySelector("input");
  if (!input) throw new Error(`input not found: ${labelText}`);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

async function modalSnapshot(client: CdpClient) {
  return client.evaluate<ModalSnapshot>(`(() => {
    const modal = document.querySelector('.xh-real-confirm-modal');
    const rect = modal?.getBoundingClientRect();
    return {
      documentWidth: document.documentElement.scrollWidth,
      modalOpen: Boolean(modal),
      modalRect: rect ? { left: rect.left, right: rect.right, width: rect.width } : null,
      signerCalls: (window.__calls?.placeOrder ?? 0) + (window.__calls?.placeOrderWithTpsl ?? 0),
      summaryText: document.querySelector('.xh-real-confirm-summary')?.textContent ?? '',
      viewportWidth: window.innerWidth,
    };
  })()`);
}

async function resetSnapshot(client: CdpClient) {
  return client.evaluate<ResetSnapshot>(`(() => {
    const fieldInput = (labelText) => [...document.querySelectorAll('label')].find((node) => node.textContent?.includes(labelText))?.querySelector('input')?.value ?? '';
    return {
      message: document.querySelector('.xh-real-order-message')?.textContent ?? '',
      modalOpen: Boolean(document.querySelector('.xh-real-confirm-modal')),
      percent: document.querySelector('.xh-real-position-percent-input input')?.value ?? '',
      price: fieldInput('价格'),
      signerCalls: (window.__calls?.placeOrder ?? 0) + (window.__calls?.placeOrderWithTpsl ?? 0),
      size: fieldInput('数量'),
      slPrice: fieldInput('止损价'),
      tpPrice: fieldInput('止盈价'),
    };
  })()`);
}

async function errorSnapshot(client: CdpClient) {
  return client.evaluate<ErrorSnapshot>(`(() => ({
    message: document.querySelector('.xh-real-order-message')?.textContent ?? '',
    modalOpen: Boolean(document.querySelector('.xh-real-confirm-modal')),
    signerCalls: (window.__calls?.placeOrder ?? 0) + (window.__calls?.placeOrderWithTpsl ?? 0),
  }))()`);
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

await main();
