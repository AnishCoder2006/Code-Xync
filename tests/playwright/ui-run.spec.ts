/**
 * Plan 2.6: Run streams the program's output into the terminal with its exit status
 * (real worker + hardened Docker sandbox); a 429 shows a readable message with retry time.
 */
import { test, expect } from "@playwright/test";
import Redis from "ioredis";
import { cleanupUsers, newUserPage, openRoom, seedRoom, seedUsers, terminalText, uid } from "./ui-helpers";

const tag = uid();
const owner = { id: `ui-run-owner-${tag}`, name: "Rita Runner" };
const limited = { id: `ui-run-limited-${tag}`, name: "Lim Ited" };

test.beforeAll(async () => seedUsers([owner, limited]));
test.afterAll(async () => cleanupUsers([owner.id, limited.id]));

test("Run shows the program output and exit code", async ({ browser }) => {
  const roomId = `ui-run-${tag}`;
  await seedRoom({
    id: roomId, title: "Run me", language: "python", members: [[owner.id, "OWNER"]],
    text: 'print("hello from codesync")\nprint(6 * 7)\n',
  });
  const { context, page } = await newUserPage(browser);
  await openRoom(page, roomId, owner);

  await page.getByTestId("run-button").click();
  await expect(page.getByTestId("run-status")).toHaveText("Finished: exit code 0", { timeout: 60_000 });
  const out = await terminalText(page);
  expect(out).toContain("hello from codesync");
  expect(out).toContain("42");
  expect(out).toContain("exited with code 0");
  await context.close();
});

test("rate limited: 429 shows when to retry and blocks the button", async ({ browser }) => {
  const roomId = `ui-run-429-${tag}`;
  await seedRoom({ id: roomId, title: "Limited", language: "python", members: [[limited.id, "OWNER"]], text: "print(1)\n" });

  // Fill this user's sliding window (EXECUTION_RATE_PER_MIN, default 10) so the next Run is refused.
  const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6380");
  const key = `ratelimit:${limited.id}:execution`;
  const now = Date.now();
  for (let i = 0; i < 10; i++) await redis.zadd(key, now - i, `${now - i}-seed-${i}`);
  await redis.pexpire(key, 120_000);

  const { context, page } = await newUserPage(browser);
  await openRoom(page, roomId, limited);
  await page.getByTestId("run-button").click();

  const err = page.getByTestId("run-error");
  await expect(err).toContainText(/Rate limit reached\. Try again in \d+ s\./);
  await expect(page.getByTestId("run-button")).toBeDisabled();
  await expect(page.getByTestId("run-button")).toContainText(/Run \(\d+s\)/);

  await redis.del(key);
  await redis.quit();
  await context.close();
});
