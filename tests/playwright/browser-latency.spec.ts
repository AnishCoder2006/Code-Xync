/**
 * Week 4 8e — edit-to-peer latency between two real browsers on two nodes.
 *
 * A (node 1) inserts a unique marker with keyboard.insertText. Send time = stamped in A's
 * page immediately before insertText (adds one Playwright round trip). Receive time = a MutationObserver in
 * B's page seeing the marker in B's Monaco DOM. Both use performance.timeOrigin +
 * performance.now() (same machine clock). That is insertText -> y-monaco -> ws -> node 1 ->
 * Redis -> node 2 -> ws -> y-monaco -> B render.
 *
 * (An earlier version timed the send when the marker appeared in A's OWN DOM; Monaco
 * renders on the next animation frame, so A's render sometimes came after B's and some
 * samples were negative. Those numbers were discarded; negative samples now fail the test.)
 * 30 samples; p50/p95 are printed with conditions and written with the raw samples to
 * test-results/browser-latency.json. No target is asserted; this only reports.
 */
import { test, expect, chromium, Page } from "@playwright/test";
import fs from "fs";
import os from "os";
import path from "path";
import * as H from "./helpers";

const SAMPLES = 30;

const pct = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];

/**
 * Sender side: stamp the send time in A's page right before the insertText call.
 * (Monaco 0.57 on Chromium does not fire a DOM `input` event for CDP insertText, so the
 * keystroke itself cannot be observed.) The gap between this stamp and the text entering
 * Monaco is one Playwright round trip, so samples are slightly OVER-estimated, never under.
 */
async function stampSend(page: Page, marker: string) {
  await page.evaluate((m) => {
    const w = window as any;
    w.__seen = w.__seen || {};
    w.__seen[m] = performance.timeOrigin + performance.now();
  }, marker);
}

/** Receiver side: time the marker's first appearance in this page's Monaco DOM. */
async function armObserver(page: Page, marker: string) {
  await page.evaluate((m) => {
    const w = window as any;
    w.__seen = w.__seen || {};
    const root = document.querySelector(".monaco-editor .view-lines")!;
    const check = () => {
      if (!w.__seen[m] && (root.textContent || "").replace(/ /g, " ").includes(m)) {
        w.__seen[m] = performance.timeOrigin + performance.now();
        obs.disconnect();
      }
    };
    const obs = new MutationObserver(check);
    obs.observe(root, { childList: true, subtree: true, characterData: true });
    check();
  }, marker);
}

const seenAt = (page: Page, marker: string, timeoutMs = 10_000) =>
  page
    .waitForFunction((m) => (window as any).__seen?.[m], marker, { timeout: timeoutMs, polling: 20 })
    .then((h) => h.jsonValue() as Promise<number>);

test("edit-to-peer latency, 30 samples (report only)", async () => {
  const roomId = "br-lat-" + H.uid();
  const users = ["bl-a-" + H.uid(), "bl-b-" + H.uid()];
  await H.seedRoom(roomId, users, "latency\n");

  const browser = await chromium.launch();
  try {
    const pageA = await (await browser.newContext()).newPage();
    const pageB = await (await browser.newContext()).newPage();
    await H.openEditor(pageA, roomId, users[0], H.PORT_NODE1);
    await H.openEditor(pageB, roomId, users[1], H.PORT_NODE2);
    expect(await H.roomClientsOn(H.PORT_NODE1, roomId)).toBe(1);
    expect(await H.roomClientsOn(H.PORT_NODE2, roomId)).toBe(1);
    await H.gotoDocEnd(pageA);

    const samples: number[] = [];
    for (let i = 0; i < SAMPLES; i++) {
      const marker = `M${String(i).padStart(2, "0")}x${H.uid().slice(0, 4)}`;
      await armObserver(pageB, marker);
      await stampSend(pageA, marker);
      await pageA.keyboard.insertText(` ${marker}`);
      const [ta, tb] = await Promise.all([seenAt(pageA, marker), seenAt(pageB, marker)]);
      samples.push(Math.round((tb - ta) * 100) / 100);
      await H.wait(150);
    }

    const sorted = [...samples].sort((a, b) => a - b);
    const result = {
      test: "browser edit-to-peer latency",
      samples_ms: samples,
      n: samples.length,
      p50_ms: pct(sorted, 50),
      p95_ms: pct(sorted, 95),
      min_ms: sorted[0],
      max_ms: sorted[sorted.length - 1],
      conditions: {
        nodes: "2 sync nodes (separate Node processes, localhost), Redis 7 in Docker Desktop (port 6380)",
        placement: "browser A -> node 1 :4041 direct, browser B -> node 2 :4042 direct",
        browsers: `2 Chromium ${browser.version()} contexts, headless, one browser process`,
        measured: "stamp in A's page just before keyboard.insertText -> marker first in B's Monaco DOM (MutationObserver); performance.timeOrigin+now; includes one Playwright round trip (over-estimates)",
        machine: `${os.type()} ${os.release()} ${os.arch()}, ${os.cpus()[0]?.model} x${os.cpus().length}, ${(os.totalmem() / 2 ** 30).toFixed(1)} GiB RAM`,
        load_generator_shares_machine: true,
      },
      timestamp: new Date().toISOString(),
    };
    fs.mkdirSync(path.join(__dirname, "test-results"), { recursive: true });
    fs.writeFileSync(path.join(__dirname, "test-results/browser-latency.json"), JSON.stringify(result, null, 2));
    console.log(`  samples (ms): ${samples.join(", ")}`);
    console.log(`  p50=${result.p50_ms}ms p95=${result.p95_ms}ms (min ${result.min_ms}, max ${result.max_ms}, n=${result.n})`);
    console.log(`  conditions: ${JSON.stringify(result.conditions)}`);
    expect(samples.length).toBe(SAMPLES);
    expect(Math.min(...samples)).toBeGreaterThanOrEqual(0); // a negative latency means the method is broken
  } finally {
    await browser.close();
  }
});
