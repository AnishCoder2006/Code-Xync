/**
 * Week 4 8d — a fix accepted through the API updates editors on BOTH nodes.
 *
 * Browser A sits on node 1, browser B on node 2. A verified AIInteraction is created
 * directly in Postgres (stands in for a finished fix loop; the LLM is not part of this
 * test). Then the real Accept flow runs: PATCH /ai/:id/accept on the API (test token,
 * OWNER/EDITOR RBAC, stale check via the sync service /text, then /apply-patch). The
 * API reaches the sync service through the LB, so the patch lands on whichever node the
 * LB picks; the other node must receive it over Redis.
 */
import { test, expect, chromium } from "@playwright/test";
import { prisma } from "../../services/api/src/lib/prisma";
import { API_PORT } from "./global-setup";
import * as H from "./helpers";

test("Accept via the API updates editors on two different nodes", async () => {
  const roomId = "br-acc-" + H.uid();
  const users = ["ba-a-" + H.uid(), "ba-b-" + H.uid()];
  const buggy = "function add(a, b) {\n  return a - b;\n}\n";
  await H.seedRoom(roomId, users, buggy);

  const interaction = await prisma.aIInteraction.create({
    data: {
      roomId,
      userId: users[0],
      prompt: "add() subtracts instead of adding",
      baseVersion: "test-base",
      baseContent: buggy,
      status: "verified",
      diffPatch: "-  return a - b;\n+  return a + b;",
    },
  });

  const browser = await chromium.launch();
  try {
    const pageA = await (await browser.newContext()).newPage();
    const pageB = await (await browser.newContext()).newPage();
    await H.openEditor(pageA, roomId, users[0], H.PORT_NODE1);
    await H.openEditor(pageB, roomId, users[1], H.PORT_NODE2);
    expect(await H.roomClientsOn(H.PORT_NODE1, roomId)).toBe(1);
    expect(await H.roomClientsOn(H.PORT_NODE2, roomId)).toBe(1);

    const res = await fetch(`http://127.0.0.1:${API_PORT}/ai/${interaction.id}/accept`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer test-token-${users[0]}` },
      body: JSON.stringify({ oldRangeText: "return a - b;", newCode: "return a + b;" }),
    });
    const body = await res.json();
    console.log(`  PATCH /ai/:id/accept -> ${res.status} status=${body.status}`);
    expect(res.status).toBe(200);
    expect(body.status).toBe("accepted");

    const fixed = (t: string) => t.includes("return a + b;") && !t.includes("return a - b;");
    const ta = await H.waitForText(pageA, fixed);
    const tb = await H.waitForText(pageB, fixed);
    console.log(`  node1 editor: ${JSON.stringify(ta)}`);
    console.log(`  node2 editor: ${JSON.stringify(tb)}`);
    expect(fixed(ta)).toBe(true);
    expect(fixed(tb)).toBe(true);
    expect(tb).toBe(ta);
  } finally {
    await browser.close();
  }
});
