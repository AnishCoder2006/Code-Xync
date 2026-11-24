/**
 * A2a / Week 4 8a — real browsers converge in the DOM.
 * Three Chromium contexts: A -> node 1, B -> node 2 (direct), C -> through the LB.
 * Their placement is asserted from each node's /health. All three type a different
 * line at the same time (Promise.all); afterwards every editor's DOM text is identical
 * and contains all three lines.
 */
import { test, expect, chromium } from "@playwright/test";
import * as H from "./helpers";

test("three browsers on two nodes type concurrently and converge in the DOM", async () => {
  const roomId = "br-conv-" + H.uid();
  const users = ["bc-a-" + H.uid(), "bc-b-" + H.uid(), "bc-c-" + H.uid()];
  // One slot line per browser so each types "a different line".
  await H.seedRoom(roomId, users, "// slot A:\n// slot B:\n// slot C:\n");

  const browser = await chromium.launch();
  try {
    const pages = await Promise.all(users.map(async () => (await browser.newContext()).newPage()));
    const ports = [H.PORT_NODE1, H.PORT_NODE2, H.LB_PORT];
    await Promise.all(pages.map((p, i) => H.openEditor(p, roomId, users[i], ports[i])));

    const n1 = await H.roomClientsOn(H.PORT_NODE1, roomId);
    const n2 = await H.roomClientsOn(H.PORT_NODE2, roomId);
    console.log(`  placement from /health: node1=${n1} node2=${n2} (A direct n1, B direct n2, C via LB)`);
    expect(n1 + n2).toBe(3);
    expect(n1).toBeGreaterThanOrEqual(1);
    expect(n2).toBeGreaterThanOrEqual(1);

    const lines = [" typed by browser A on node 1", " typed by browser B on node 2", " typed by browser C via the LB"];
    // Position every cursor first, then type simultaneously.
    for (let i = 0; i < 3; i++) await H.gotoLineEnd(pages[i], i + 1);
    await Promise.all(pages.map((p, i) => H.typeText(p, lines[i], 20)));

    const all = (t: string) => lines.every((l) => t.includes(l));
    const texts = await Promise.all(pages.map((p) => H.waitForText(p, all, 15_000)));
    texts.forEach((t, i) => console.log(`  ${"ABC"[i]} DOM: ${JSON.stringify(t)}`));

    for (const t of texts) for (const l of lines) expect(t).toContain(l);
    expect(texts[1]).toBe(texts[0]);
    expect(texts[2]).toBe(texts[0]);
  } finally {
    await browser.close();
  }
});
