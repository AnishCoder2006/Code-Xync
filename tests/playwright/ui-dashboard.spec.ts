/**
 * Plan 2.1 + 2.2: landing page for signed-out users, protected route redirect,
 * dashboard create -> lands in room, list, join by invite link (+ passcode) by a 2nd user.
 */
import { test, expect } from "@playwright/test";
import { appUrl, cleanupUsers, newUserPage, seedUsers, uid } from "./ui-helpers";

const tag = uid();
const alice = { id: `ui-dash-alice-${tag}`, name: "Alice Archer" };
const bob = { id: `ui-dash-bob-${tag}`, name: "Bob Baker" };

test.beforeAll(async () => seedUsers([alice, bob]));
test.afterAll(async () => cleanupUsers([alice.id, bob.id]));

test("signed-out: landing page, and /rooms redirects to sign-in", async ({ browser }) => {
  const { context, page } = await newUserPage(browser);
  await page.goto(appUrl("/"));
  await expect(page.getByTestId("landing")).toBeVisible();
  await expect(page.getByRole("link", { name: "Create an account" })).toBeVisible();

  await page.goto(appUrl("/rooms"));
  await page.waitForURL(/\/sign-in\?redirect_url=%2Frooms/);
  await expect(page.getByTestId("test-sign-in")).toBeVisible();
  await context.close();
});

test("create a room, see it listed, second user joins with the passcode", async ({ browser }) => {
  // ── Alice: empty dashboard -> create ──────────────────────────────────
  const a = await newUserPage(browser);
  await a.page.goto(appUrl("/rooms", alice));
  await expect(a.page.getByTestId("rooms-empty")).toBeVisible();

  const create = a.page.getByTestId("create-form");
  await create.getByRole("button", { name: "Create room" }).click();
  await expect(a.page.getByTestId("create-error")).toHaveText("Give the room a name.");

  await create.locator('input[name="title"]').fill(`Parser pairing ${tag}`);
  // Radix Select (shadcn/ui): open it and pick like a user.
  await create.getByTestId("language-select").click();
  await a.page.getByRole("option", { name: "JavaScript" }).click();
  await create.getByTestId("language-select").click();
  await a.page.getByRole("option", { name: "Python" }).click();
  await expect(create.getByTestId("language-select")).toHaveText("Python");
  await create.locator('input[name="passcode"]').fill("open-sesame");
  await create.getByRole("button", { name: "Create room" }).click();

  await a.page.waitForURL(/\/room\/[^/?]+/);
  const roomId = decodeURIComponent(new URL(a.page.url()).pathname.split("/").pop()!);
  await expect(a.page.getByTestId("room-title")).toHaveText(`Parser pairing ${tag}`);
  await expect(a.page.getByTestId("my-role")).toHaveText("Owner");

  await a.page.goto(appUrl("/rooms"));
  const card = a.page.locator(`[data-testid="room-card"][data-room-id="${roomId}"]`);
  await expect(card).toContainText(`Parser pairing ${tag}`);
  await expect(card).toContainText("Python");
  await expect(card.getByTestId("room-role")).toHaveText("Owner");

  // ── Bob: join by invite link; passcode errors are inline ───────────────
  const b = await newUserPage(browser);
  await b.page.goto(appUrl("/rooms", bob));
  await expect(b.page.getByTestId("rooms-empty")).toBeVisible();
  await b.page.getByRole("tab", { name: "Join a room" }).click();
  const join = b.page.getByTestId("join-form");

  await join.locator('input[name="roomId"]').fill(`does-not-exist-${tag}`);
  await join.getByRole("button", { name: "Join room" }).click();
  await expect(b.page.getByTestId("join-error")).toHaveText("No room with that ID. Check the invite link.");

  await join.locator('input[name="roomId"]').fill(`http://localhost:3100/room/${roomId}`);
  await join.getByRole("button", { name: "Join room" }).click();
  await expect(b.page.getByTestId("join-error")).toHaveText("This room needs a passcode.");

  await join.locator('input[name="passcode"]').fill("wrong");
  await join.getByRole("button", { name: "Join room" }).click();
  await expect(b.page.getByTestId("join-error")).toHaveText("That passcode is not correct.");

  await join.locator('input[name="passcode"]').fill("open-sesame");
  await join.getByRole("button", { name: "Join room" }).click();
  await b.page.waitForURL(new RegExp(`/room/${roomId}`));
  await expect(b.page.getByTestId("my-role")).toHaveText("Editor");

  await b.page.goto(appUrl("/rooms"));
  const bobCard = b.page.locator(`[data-testid="room-card"][data-room-id="${roomId}"]`);
  await expect(bobCard.getByTestId("room-role")).toHaveText("Editor");
  await expect(bobCard).toContainText("2 members");

  await a.context.close();
  await b.context.close();
});
