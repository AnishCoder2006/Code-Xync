/**
 * Plan 2.4: two browsers see each other's avatar and named, coloured remote cursor;
 * the avatar disappears when the other person leaves.
 */
import { test, expect } from "@playwright/test";
import { cleanupUsers, editorLineEnd, newUserPage, openRoom, seedRoom, seedUsers, uid, waitForEditorText } from "./ui-helpers";

const tag = uid();
const ann = { id: `ui-pres-ann-${tag}`, name: "Ann Lee" };
const ben = { id: `ui-pres-ben-${tag}`, name: "Ben Ortiz" };

test.beforeAll(async () => seedUsers([ann, ben]));
test.afterAll(async () => cleanupUsers([ann.id, ben.id]));

test("avatars and remote cursor between two browsers; avatar leaves with the user", async ({ browser }) => {
  const roomId = `ui-pres-${tag}`;
  await seedRoom({
    id: roomId, title: "Presence", language: "javascript",
    members: [[ann.id, "OWNER"], [ben.id, "EDITOR"]],
    text: "const a = 1;\nconst b = 2;\n",
  });
  const A = await newUserPage(browser);
  const B = await newUserPage(browser);
  await openRoom(A.page, roomId, ann);
  await openRoom(B.page, roomId, ben);

  for (const [page, other] of [[A.page, ben], [B.page, ann]] as const) {
    await expect(page.getByTestId("avatar")).toHaveCount(2);
    await expect(page.locator(`[data-testid="avatar"][data-user-id="${other.id}"]`)).toHaveAttribute("title", other.name);
  }
  await expect(B.page.locator(`[data-testid="avatar"][data-user-id="${ann.id}"]`)).toHaveText("AL");

  // Ann moves her cursor and types: Ben sees her edit, her cursor head, and her name label.
  await editorLineEnd(A.page, 2);
  await A.page.keyboard.type(" // ann", { delay: 20 });
  await waitForEditorText(B.page, (t) => t.includes("const b = 2; // ann"));
  await expect(B.page.locator('[data-testid="editor-area"] [class*="yRemoteSelectionHead-"]').first()).toBeAttached();
  const css = await B.page.evaluate(() => document.querySelector('style[data-codesync="remote-cursors"]')?.textContent ?? "");
  expect(css).toContain('content:"Ann Lee"');

  // Ann leaves: her avatar goes away on Ben's side.
  await A.context.close();
  await expect(B.page.getByTestId("avatar")).toHaveCount(1, { timeout: 20_000 });
  await expect(B.page.locator(`[data-testid="avatar"][data-user-id="${ben.id}"]`)).toBeVisible();
  await B.context.close();
});
