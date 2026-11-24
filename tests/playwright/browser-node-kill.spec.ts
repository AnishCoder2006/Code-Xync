/**
 * A2c / Week 4 8c — kill the node a browser is on.
 *
 * Private cluster for this test (so killing a node does not disturb other specs):
 * node 1 :4061, node 2 :4062, LB :4060. Both browsers connect ONLY through the LB.
 *
 *  1. A and B connect through the LB; /health shows they landed on different nodes.
 *  2. Both type; both converge.
 *  3. Kill A's node hard (taskkill /T /F). B keeps typing. A keeps typing during the
 *     outage too (those keystrokes live only in A's local Y.Doc for now).
 *  4. The SAME page A (no reload: same pageLoadId) reconnects by itself through the
 *     LB to the surviving node (connects 1 -> 2), and A and B converge.
 *  5. Restart the killed node; a NEW browser C connects directly to it and sees the
 *     whole document, then C types and A and B see it.
 */
import { test, expect, chromium } from "@playwright/test";
import { ChildProcess } from "child_process";
import * as H from "./helpers";

const P1 = 4061;
const P2 = 4062;
const LBP = 4060;

test("kill a node: the same browser reconnects through the LB and keeps editing; a new browser sees everything", async () => {
  const roomId = "br-kill-" + H.uid();
  const users = ["bk-a-" + H.uid(), "bk-b-" + H.uid(), "bk-c-" + H.uid()];
  await H.seedRoom(roomId, users, "line for A:\nline for B:\n");

  const nodes: Record<number, ChildProcess | null> = {
    [P1]: await H.startNode(P1, "bk-node-01"),
    [P2]: await H.startNode(P2, "bk-node-02"),
  };
  const lb = await H.startLB(LBP, [P1, P2]);
  await H.wait(1200); // let the LB health-check both backends

  const browser = await chromium.launch();
  try {
    const pageA = await (await browser.newContext()).newPage();
    const pageB = await (await browser.newContext()).newPage();
    await H.openEditor(pageA, roomId, users[0], LBP);
    const aOn1 = await H.roomClientsOn(P1, roomId);
    const aPort = aOn1 === 1 ? P1 : P2;
    const otherPort = aPort === P1 ? P2 : P1;
    await H.openEditor(pageB, roomId, users[1], LBP);
    console.log(`  A landed on :${aPort}; clients node1=${await H.roomClientsOn(P1, roomId)} node2=${await H.roomClientsOn(P2, roomId)}`);
    expect(await H.roomClientsOn(aPort, roomId)).toBe(1);
    expect(await H.roomClientsOn(otherPort, roomId)).toBe(1); // B on the other node
    console.log("  LB routing log:\n    " + lb.log.filter((l) => l.includes(" ws ")).join("\n    "));

    await H.gotoLineEnd(pageA, 1);
    await H.typeText(pageA, " A-before-kill");
    await H.gotoLineEnd(pageB, 2);
    await H.typeText(pageB, " B-before-kill");
    const pre = (t: string) => t.includes("A-before-kill") && t.includes("B-before-kill");
    expect(pre(await H.waitForText(pageA, pre))).toBe(true);
    expect(pre(await H.waitForText(pageB, pre))).toBe(true);
    const aBefore = await H.pageState(pageA);

    // ── kill A's node ────────────────────────────────────────────────────
    console.log(`  killing node on :${aPort} (hard)`);
    H.killProc(nodes[aPort]);
    nodes[aPort] = null;
    const tKill = Date.now();

    // B keeps editing; A keeps typing while its socket is down.
    await H.gotoLineEnd(pageB, 2);
    await H.typeText(pageB, " B-after-kill");
    await H.gotoLineEnd(pageA, 1);
    await H.typeText(pageA, " A-during-outage");

    // A reconnects on its own (no navigation) through the LB.
    await pageA.waitForFunction(
      (prev) => (window.__e2e?.connects ?? 0) > prev && window.__e2e?.status === "connected",
      aBefore.connects,
      { timeout: 30_000 }
    );
    const aAfter = await H.pageState(pageA);
    console.log(
      `  A reconnected after ${Date.now() - tKill}ms: connects ${aBefore.connects} -> ${aAfter.connects}, ` +
        `same page load: ${aAfter.pageLoadId === aBefore.pageLoadId}; survivor :${otherPort} clients=${await H.roomClientsOn(otherPort, roomId)}`
    );
    expect(aAfter.pageLoadId).toBe(aBefore.pageLoadId);
    expect(await H.roomClientsOn(otherPort, roomId)).toBe(2);

    await H.gotoLineEnd(pageA, 1);
    await H.typeText(pageA, " A-after-reconnect");

    const want = ["A-before-kill", "B-before-kill", "B-after-kill", "A-during-outage", "A-after-reconnect"];
    const all = (t: string) => want.every((w) => t.includes(w));
    const ta = await H.waitForText(pageA, all, 20_000);
    const tb = await H.waitForText(pageB, all, 20_000);
    console.log(`  A: ${JSON.stringify(ta)}`);
    console.log(`  B: ${JSON.stringify(tb)}`);
    for (const w of want) {
      expect(ta).toContain(w);
      expect(tb).toContain(w);
    }
    expect(tb).toBe(ta);

    // ── restart the killed node; a NEW browser joins it directly ────────
    nodes[aPort] = await H.startNode(aPort, "bk-node-restarted");
    const pageC = await (await browser.newContext()).newPage();
    await H.openEditor(pageC, roomId, users[2], aPort);
    const tc = await H.waitForText(pageC, all, 20_000);
    console.log(`  C (new browser on restarted :${aPort}): ${JSON.stringify(tc)}`);
    expect(tc).toBe(ta);

    await H.gotoDocEnd(pageC);
    await H.typeText(pageC, "C-on-restarted-node");
    const withC = (t: string) => all(t) && t.includes("C-on-restarted-node");
    expect(withC(await H.waitForText(pageA, withC))).toBe(true);
    expect(withC(await H.waitForText(pageB, withC))).toBe(true);
  } finally {
    await browser.close();
    H.killProc(nodes[P1]);
    H.killProc(nodes[P2]);
    H.killProc(lb.proc);
  }
});
