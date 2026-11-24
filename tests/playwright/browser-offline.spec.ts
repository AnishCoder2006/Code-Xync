/**
 * A2b / Week 4 8b — offline/online with context.setOffline.
 *
 * Measured on this Chromium (Playwright 1.64): setOffline(true) does NOT close an open
 * WebSocket — the socket stays "connected" while frames are held back in both
 * directions, then flush on setOffline(false). So two cases are tested:
 *
 *  1. "stall": offline for a few seconds mid-edit. Asserts the offline browser really
 *     was cut off (neither side sees the other's new text while offline), then that the
 *     SAME editor (same page load, no reload) merges both sides' edits.
 *  2. "disconnect": offline for longer than y-websocket's 30s silence timeout, so the
 *     client itself drops the socket and must RECONNECT (connects 1 -> 2) when online.
 *
 * In both, browser A goes offline while B (node 2) and C (node 1) keep typing.
 */
import { test, expect, chromium, Page } from "@playwright/test";
import * as H from "./helpers";

async function scenario(offlineMs: number, expectReconnect: boolean) {
  const roomId = "br-off-" + H.uid();
  const users = ["bo-a-" + H.uid(), "bo-b-" + H.uid(), "bo-c-" + H.uid()];
  // B types on line 1, C on line 2, A at the end (line 3): no two browsers share a spot.
  await H.seedRoom(roomId, users, "line for B:\nline for C:\n");

  const browser = await chromium.launch();
  try {
    const ctxA = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await (await browser.newContext()).newPage();
    const pageC = await (await browser.newContext()).newPage();
    await H.openEditor(pageA, roomId, users[0], H.PORT_NODE1);
    await H.openEditor(pageB, roomId, users[1], H.PORT_NODE2);
    await H.openEditor(pageC, roomId, users[2], H.PORT_NODE1);
    const before = await H.pageState(pageA);

    // A starts a line, goes offline mid-edit, and keeps typing.
    await H.gotoDocEnd(pageA);
    await H.typeText(pageA, "A-before-offline ");
    await H.waitForText(pageB, (t) => t.includes("A-before-offline"));
    await ctxA.setOffline(true);
    await H.typeText(pageA, "A-typed-while-offline");

    // The other two keep typing on their own lines.
    const typeLine = async (p: Page, line: number, text: string) => {
      await H.gotoLineEnd(p, line);
      await H.typeText(p, text);
    };
    await Promise.all([typeLine(pageB, 1, " B-online"), typeLine(pageC, 2, " C-online")]);
    await H.wait(1500);

    const aOffline = await H.getEditorText(pageA);
    const bOffline = await H.getEditorText(pageB);
    console.log(`  while offline  A: ${JSON.stringify(aOffline)}`);
    console.log(`  while offline  B: ${JSON.stringify(bOffline)}`);
    expect(aOffline).toContain("A-typed-while-offline");
    expect(aOffline).not.toContain("B-online"); // A really is cut off...
    expect(bOffline).not.toContain("A-typed-while-offline"); // ...in both directions

    const remaining = offlineMs - 1500;
    if (remaining > 0) await H.wait(remaining);
    const duringState = await H.pageState(pageA);
    await ctxA.setOffline(false);

    const want = ["A-before-offline", "A-typed-while-offline", "B-online", "C-online"];
    const all = (t: string) => want.every((w) => t.includes(w));
    const [ta, tb, tc] = await Promise.all([pageA, pageB, pageC].map((p) => H.waitForText(p, all, 30_000)));
    const after = await H.pageState(pageA);
    console.log(`  after online   A: ${JSON.stringify(ta)}`);
    console.log(
      `  A provider: before=${JSON.stringify({ c: before.connects, d: before.disconnects })} ` +
        `end-of-offline=${JSON.stringify({ s: duringState.status, c: duringState.connects, d: duringState.disconnects })} ` +
        `after=${JSON.stringify({ s: after.status, c: after.connects, d: after.disconnects })}`
    );

    for (const t of [ta, tb, tc]) for (const w of want) expect(t).toContain(w);
    expect(tb).toBe(ta);
    expect(tc).toBe(ta);
    expect(after.pageLoadId).toBe(before.pageLoadId); // the SAME editor, never reloaded
    if (expectReconnect) {
      expect(after.connects).toBeGreaterThanOrEqual(2);
    } else {
      expect(after.connects).toBe(before.connects);
    }
  } finally {
    await browser.close();
  }
}

test("offline stall: setOffline mid-edit, both sides type, the same editor merges both", async () => {
  await scenario(4000, false);
});

test("offline past the 30s silence timeout: client drops the socket, reconnects, merges", async () => {
  test.setTimeout(150_000);
  await scenario(40_000, true);
});
