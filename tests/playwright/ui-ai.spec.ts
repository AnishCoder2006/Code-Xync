/**
 * Plan 2.7: AI fix panel with the mock LLM (mock_scenario) and the real sandbox.
 *  - progress steps arrive in order (mixed scenario: malformed first answer -> retry),
 *    diff shown, attempts/cost shown, Accept updates both editors on two sync nodes
 *  - stale patch: the other user edits the function before Accept -> stale message
 */
import { test, expect } from "@playwright/test";
import { PORT_NODE1, PORT_NODE2 } from "./helpers";
import { cleanupUsers, editorLineEnd, newUserPage, openRoom, seedRoom, seedUsers, serverText, uid, waitForEditorText } from "./ui-helpers";

const tag = uid();
const amy = { id: `ui-ai-amy-${tag}`, name: "Amy Fixer" };
const bo = { id: `ui-ai-bo-${tag}`, name: "Bo Pair" };
const BUGGY = "def add(a, b):\n    return a - b\n\n\nprint(add(2, 3))\n";

test.beforeAll(async () => seedUsers([amy, bo]));
test.afterAll(async () => cleanupUsers([amy.id, bo.id]));

const node = (port: number) => `ws://127.0.0.1:${port}`;

test("progress steps in order, diff, Accept updates both editors on two nodes", async ({ browser }) => {
  const roomId = `ui-ai-${tag}`;
  await seedRoom({ id: roomId, title: "AI fix", language: "python", members: [[amy.id, "OWNER"], [bo.id, "EDITOR"]], text: BUGGY });
  const A = await newUserPage(browser);
  const B = await newUserPage(browser);
  await openRoom(A.page, roomId, amy, node(PORT_NODE1));
  await openRoom(B.page, roomId, bo, node(PORT_NODE2));

  await A.page.getByTestId("ai-button").click();
  await A.page.getByTestId("ai-prompt").fill(`add() should add, not subtract [[b6:mixed:add:t${tag}a]]`);
  await A.page.getByTestId("ai-generate").click();

  await expect(A.page.getByTestId("ai-diff")).toBeVisible({ timeout: 60_000 });
  const steps = await A.page.locator('[data-testid="ai-step"]').evaluateAll((els) =>
    els.map((e) => `${e.getAttribute("data-step")}${e.getAttribute("data-attempt") ? ":" + e.getAttribute("data-attempt") : ""}`)
  );
  expect(steps).toEqual(["context", "generating:1", "retrying:2", "generating:2", "applying:2", "testing:2", "done"]);
  await expect(A.page.locator('[data-testid="ai-step"][data-step="retrying"]')).toContainText("the AI's answer was malformed");
  await expect(A.page.getByTestId("ai-attempts")).toHaveText("2 attempts");
  await expect(A.page.getByTestId("ai-cost")).toHaveText(/^\$\d+\.\d{4}$/);
  await expect(A.page.getByTestId("ai-diff")).toContainText("return a + b");

  await A.page.getByTestId("ai-accept").click();
  await expect(A.page.getByTestId("ai-accepted")).toBeVisible();
  await expect(A.page.getByTestId("ai-diff")).toHaveCount(0);

  for (const page of [A.page, B.page]) {
    const t = await waitForEditorText(page, (s) => s.includes("return a + b"));
    expect(t).toContain("return a + b");
    expect(t).not.toContain("return a - b");
  }
  expect(await serverText(roomId)).toContain("return a + b");
  await A.context.close();
  await B.context.close();
});

test("stale patch: file edited while the AI worked -> regenerate message", async ({ browser }) => {
  const roomId = `ui-ai-stale-${tag}`;
  await seedRoom({ id: roomId, title: "AI stale", language: "python", members: [[amy.id, "OWNER"], [bo.id, "EDITOR"]], text: BUGGY });
  const A = await newUserPage(browser);
  const B = await newUserPage(browser);
  await openRoom(A.page, roomId, amy, node(PORT_NODE1));
  await openRoom(B.page, roomId, bo, node(PORT_NODE2));

  await A.page.getByTestId("ai-button").click();
  await A.page.getByTestId("ai-prompt").fill(`fix add [[b6:valid:add:t${tag}b]]`);
  await A.page.getByTestId("ai-generate").click();
  await expect(A.page.getByTestId("ai-diff")).toBeVisible({ timeout: 60_000 });

  // Bo changes the function the AI targeted before Amy accepts.
  await editorLineEnd(B.page, 2);
  await B.page.keyboard.type("  # bo was here", { delay: 20 });
  await expect.poll(() => serverText(roomId), { timeout: 15_000 }).toContain("return a - b  # bo was here");

  await A.page.getByTestId("ai-accept").click();
  await expect(A.page.getByTestId("ai-stale")).toContainText("The file changed while the AI was working");
  await expect(A.page.getByTestId("ai-generate")).toHaveText("Regenerate");
  // The live document keeps Bo's edit; the stale patch was not applied.
  expect(await serverText(roomId)).toContain("return a - b  # bo was here");
  await A.context.close();
  await B.context.close();
});
