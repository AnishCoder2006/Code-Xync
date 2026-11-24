/**
 * The pages and panels added after Part 2: room tools (History, People, Search),
 * Activity, System, Benchmarks, and multi-language rooms.
 */
import { test, expect } from "@playwright/test";
import {
  appUrl, cleanupUsers, editorLineEnd, newUserPage, openRoom, seedRoom, seedUsers, serverText, terminalText, uid, waitForEditorText,
} from "./ui-helpers";

const tag = uid();
const olu = { id: `ui-tools-olu-${tag}`, name: "Olu Owner" };
const eve = { id: `ui-tools-eve-${tag}`, name: "Eve Editor" };

test.beforeAll(async () => seedUsers([olu, eve]));
test.afterAll(async () => cleanupUsers([olu.id, eve.id]));

test("history shows a run; activity page lists it", async ({ browser }) => {
  const roomId = `ui-tools-hist-${tag}`;
  await seedRoom({ id: roomId, title: "History room", language: "python", members: [[olu.id, "OWNER"]], text: 'print("history check")\n' });
  const { context, page } = await newUserPage(browser);
  await openRoom(page, roomId, olu);

  await page.getByTestId("run-button").click();
  await expect(page.getByTestId("run-status")).toHaveText("Finished: exit code 0", { timeout: 60_000 });

  await page.getByTestId("history-button").click();
  const run = page.locator('[data-testid="history-run"]').first();
  await expect(run).toHaveAttribute("data-status", "passed");
  await expect(run).toContainText("Olu Owner");
  await expect(run).toContainText("history check");

  await page.goto(appUrl("/activity"));
  await expect(page.getByTestId("activity-runs")).toContainText("History room");
  await context.close();
});

test("owner demotes an editor: their open editor turns read-only without a reload", async ({ browser }) => {
  const roomId = `ui-tools-people-${tag}`;
  await seedRoom({ id: roomId, title: "People room", language: "python", members: [[olu.id, "OWNER"], [eve.id, "EDITOR"]], text: "x = 1\n" });
  const O = await newUserPage(browser);
  const E = await newUserPage(browser);
  await openRoom(O.page, roomId, olu);
  await openRoom(E.page, roomId, eve);
  await expect(E.page.getByTestId("my-role")).toHaveText("Editor");

  await O.page.getByTestId("people-button").click();
  const eveRow = O.page.locator(`[data-testid="member"][data-user-id="${eve.id}"]`);
  await expect(eveRow).toBeVisible();
  await eveRow.getByTestId("member-role-select").click();
  await O.page.getByRole("option", { name: "Viewer" }).click();
  await expect(eveRow).toHaveAttribute("data-role", "VIEWER");

  // Eve's page: socket dropped by the sync node, reconnects, page re-reads the role.
  await expect(E.page.getByTestId("my-role")).toHaveText("Viewer", { timeout: 20_000 });
  await expect(E.page.getByTestId("viewer-banner")).toBeVisible();
  await expect(E.page.getByTestId("conn-pill")).toHaveAttribute("data-state", "connected", { timeout: 20_000 });
  await editorLineEnd(E.page, 1);
  await E.page.keyboard.type(" # demoted", { delay: 20 });
  await E.page.waitForTimeout(1000);
  expect(await serverText(roomId)).toBe("x = 1\n");

  await O.context.close();
  await E.context.close();
});

test("search finds code after it is typed, and jumps to it", async ({ browser }) => {
  test.setTimeout(150_000);
  const roomId = `ui-tools-search-${tag}`;
  await seedRoom({ id: roomId, title: "Search room", language: "python", members: [[olu.id, "OWNER"]], text: "\n" });
  const { context, page } = await newUserPage(browser);
  await openRoom(page, roomId, olu);

  // Typing makes the sync node publish an index event ~5 s after the last keystroke.
  await editorLineEnd(page, 1);
  await page.keyboard.type("def compute_invoice_total(items):\n", { delay: 10 });
  await page.keyboard.type("return sum(i.price * i.qty for i in items)\n", { delay: 10 });
  await waitForEditorText(page, (t) => t.includes("compute_invoice_total"));

  await page.getByTestId("search-button").click();
  await page.getByTestId("search-input").fill("invoice total price quantity");
  // The index updates asynchronously; search until the function shows up.
  await expect
    .poll(
      async () => {
        await page.getByTestId("search-submit").click();
        await page.waitForSelector('[data-testid="search-results"], [data-testid="search-empty"]', { timeout: 20_000 });
        return (await page.locator('[data-testid="search-hit"]').allInnerTexts()).join("\n");
      },
      { timeout: 90_000, intervals: [3000] }
    )
    .toContain("compute_invoice_total");

  await page.locator('[data-testid="search-hit"]', { hasText: "compute_invoice_total" }).first().click();
  const selected = await page.evaluate(() => (window.getSelection()?.toString() ?? "") || document.querySelector(".monaco-editor .selected-text") !== null);
  expect(selected).toBeTruthy();
  await context.close();
});

test("system page: all services healthy, both sync nodes listed", async ({ browser }) => {
  const { context, page } = await newUserPage(browser);
  await page.goto(appUrl("/system", olu));
  await expect(page.getByTestId("system-overall")).toHaveAttribute("data-healthy", "true", { timeout: 20_000 });
  await expect(page.getByTestId("system-overall")).toHaveText("All systems operational");
  await expect(page.getByTestId("sync-node")).toHaveCount(2);
  for (const svc of ["svc-api", "svc-redis", "svc-ai", "svc-queue"]) await expect(page.getByTestId(svc)).toHaveAttribute("data-ok", "true");
  await context.close();
});

test("benchmarks page shows the recorded results, signed out", async ({ browser }) => {
  const { context, page } = await newUserPage(browser);
  await page.goto(appUrl("/benchmarks"));
  await expect(page.getByTestId("bench-headline")).toContainText("0 / 200");
  await expect(page.getByTestId("bench-attacks").locator("tbody tr")).toHaveCount(8);
  await expect(page.getByTestId("bench-retrieval")).toContainText("96%");
  await context.close();
});

test("languages: a Ruby room runs; a Go room is edit-only with a reason", async ({ browser }) => {
  const { context, page } = await newUserPage(browser);
  await page.goto(appUrl("/rooms", olu));
  const create = page.getByTestId("create-form");
  await create.locator('input[name="title"]').fill(`Ruby ${tag}`);
  await create.getByTestId("language-select").click();
  await page.getByRole("option", { name: "Ruby" }).click();
  await expect(create).toContainText("Edit together, run in the sandbox, and ask for AI fixes.");
  await create.getByRole("button", { name: "Create room" }).click();
  await page.waitForURL(/\/room\//);
  await expect(page.getByTestId("conn-pill")).toHaveAttribute("data-state", "connected", { timeout: 30_000 });
  await page.waitForSelector('[data-testid="editor-area"] .monaco-editor .view-lines');
  await page.waitForTimeout(300);
  await editorLineEnd(page, 1);
  await page.keyboard.type('puts "ruby #{6 * 7}"', { delay: 15 });
  await page.getByTestId("run-button").click();
  await expect(page.getByTestId("run-status")).toHaveText("Finished: exit code 0", { timeout: 60_000 });
  expect(await terminalText(page)).toContain("ruby 42");

  await page.goto(appUrl("/rooms"));
  await create.locator('input[name="title"]').fill(`Go ${tag}`);
  await create.getByTestId("language-select").click();
  await page.getByRole("option", { name: "Go", exact: true }).click();
  await expect(create).toContainText("Running and AI fixes are not available for this language yet.");
  await create.getByRole("button", { name: "Create room" }).click();
  await page.waitForURL(/\/room\//);
  await expect(page.getByTestId("run-button")).toBeDisabled();
  await expect(page.getByTestId("run-button")).toHaveAttribute("title", "Running Go is not available yet. You can still edit together.");
  await expect(page.getByTestId("ai-button")).toBeDisabled();
  await context.close();
});
