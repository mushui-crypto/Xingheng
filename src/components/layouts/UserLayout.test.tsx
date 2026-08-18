import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { ArbitrageMenuItems, ArbitrageNavigationMenu } from "./UserLayout";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

test("arbitrage navigation collapses the three routes under one menu", () => {
  const html = renderToStaticMarkup(
    <MemoryRouter initialEntries={["/app/funding-arbitrage"]}>
      <ArbitrageNavigationMenu pathname="/app/funding-arbitrage" />
      <ArbitrageMenuItems />
    </MemoryRouter>,
  );

  assert.match(html, /aria-haspopup="menu"/);
  assert.match(html, />套利系统</);
  assert.match(html, /href="\/app\/arbitrage"[^>]*>套利看板</);
  assert.match(html, /href="\/app\/funding-arbitrage"[^>]*>套利分析</);
  assert.match(html, /href="\/app\/my-arbitrage"[^>]*>我的套利</);
});
