/**
 * Plan 2.5: a VIEWER reads along but cannot type; Run and AI are disabled with a reason.
 * The editor still updates live when others edit.
 */
import { test, expect } from "@playwright/test";
import { cleanupUsers, editorLineEnd, newUserPage, openRoom, seedRoom, seedUsers, serverText, uid, waitForEditorText } from "./ui-helpers";

const tag = uid();
const olga = { id: `ui-view-olga-${tag}`, name: "Olga Owner" };
const vic = { id: `ui-view-vic-${tag}`, name: "Vic Viewer" };

test.beforeAll(async () => seedUsers([olga, vic]));
test.afterAll(async () => cleanupUsers([olga.id, vic.id]));

test("viewer is read-only; Run and AI disabled with a reason", async ({ browser }) => {
  const roomId = `ui-view-${tag}`;
  const initial = "x = 1\n";
  await seedRoom({ id: roomId, title: "Read only", language: "python", members: [[olga.id, "OWNER"], [vic.id, "VIEWER"]], text: initial });
  const O = await newUserPage(browser);
  const V = await newUserPage(browser);
  await openRoom(O.page, roomId, olga);
  await openRoom(V.page, roomId, vic);

  await expect(V.page.getByTestId("my-role")).toHaveText("Viewer");
  await expect(V.page.getByTestId("viewer-banner")).toContainText("you can read along, but not edit, run code or ask for AI fixes");
  await expect(V.page.getByTestId("run-button")).toBeDisabled();
  await expect(V.page.getByTestId("ai-button")).toBeDisabled();
  await expect(V.page.getByTestId("run-button")).toHaveAttribute("title", /You're a viewer/);

  // Typing does nothing locally, on the server, or for the owner.
  await editorLineEnd(V.page, 1);
  await V.page.keyboard.type(" VIEWER_TYPED", { delay: 20 });
  await V.page.waitForTimeout(800);
  expect(await waitForEditorText(V.page, () => false, 300)).not.toContain("VIEWER_TYPED");
  expect(await serverText(roomId)).toBe(initial);
  expect(await waitForEditorText(O.page, () => false, 300)).not.toContain("VIEWER_TYPED");

  // Owner edits still reach the viewer.
  await editorLineEnd(O.page, 1);
  await O.page.keyboard.type("  # owner", { delay: 20 });
  const seen = await waitForEditorText(V.page, (t) => t.includes("x = 1  # owner"));
  expect(seen).toContain("x = 1  # owner");

  await O.context.close();
  await V.context.close();
});
