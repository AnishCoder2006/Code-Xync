/**
 * Helpers for the product UI suite (ui-*.spec.ts). Pages are the real app pages in an
 * E2E build: identity comes from ?as=<userId>&name=<name> (src/e2e/testAuth.tsx).
 */
import { Browser, BrowserContext, Page, expect } from "@playwright/test";
import * as Y from "yjs";
import { prisma } from "../../services/api/src/lib/prisma";
import { WEB_URL, INTERNAL_SECRET, LB_PORT, uid } from "./helpers";

export { uid };

export type Role = "OWNER" | "EDITOR" | "VIEWER";

export async function seedUsers(users: { id: string; name: string }[]) {
  for (const u of users) {
    await prisma.user.upsert({ where: { id: u.id }, create: { id: u.id, email: `${u.id}@ui.test`, name: u.name }, update: { name: u.name } });
  }
}

export async function seedRoom(opts: {
  id: string;
  title: string;
  language: "python" | "javascript";
  members: [string, Role][];
  text?: string;
}) {
  await prisma.room.create({
    data: {
      id: opts.id,
      title: opts.title,
      defaultLang: opts.language,
      ownerId: opts.members[0][0],
      members: { create: opts.members.map(([userId, role]) => ({ userId, role })) },
    },
  });
  if (opts.text !== undefined) {
    const d = new Y.Doc();
    d.getText("content").insert(0, opts.text);
    await prisma.projectFile.create({
      data: {
        roomId: opts.id,
        path: opts.language === "python" ? "main.py" : "main.js",
        language: opts.language,
        yjsState: Buffer.from(Y.encodeStateAsUpdate(d)),
      },
    });
  }
}

/** Remove everything the given users own or touched. */
export async function cleanupUsers(userIds: string[]) {
  const rooms = await prisma.room.findMany({
    where: { OR: [{ ownerId: { in: userIds } }, { members: { some: { userId: { in: userIds } } } }] },
    select: { id: true },
  });
  const roomIds = rooms.map((r) => r.id);
  const byRoomOrUser = { OR: [{ roomId: { in: roomIds } }, { userId: { in: userIds } }] };
  await prisma.aIInteraction.deleteMany({ where: byRoomOrUser });
  await prisma.executionLog.deleteMany({ where: byRoomOrUser });
  await prisma.projectFile.deleteMany({ where: { roomId: { in: roomIds } } });
  await prisma.codeSnapshot.deleteMany({ where: { roomId: { in: roomIds } } });
  await prisma.roomMember.deleteMany({ where: byRoomOrUser });
  await prisma.room.deleteMany({ where: { id: { in: roomIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

export const appUrl = (path: string, as?: { id: string; name: string }, extra: Record<string, string> = {}) => {
  const q = new URLSearchParams({ ...(as ? { as: as.id, name: as.name } : {}), ...extra });
  const qs = q.toString();
  return `${WEB_URL}${path}${qs ? (path.includes("?") ? "&" : "?") + qs : ""}`;
};

/** A fresh browser context (own storage = own identity). */
export async function newUserPage(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  return { context, page };
}

/** Open /room/<id> as a user and wait for: room loaded, editor mounted, connected + synced. */
export async function openRoom(page: Page, roomId: string, as: { id: string; name: string }, syncUrl?: string) {
  await page.goto(appUrl(`/room/${encodeURIComponent(roomId)}`, as, syncUrl ? { syncUrl } : {}));
  await expect(page.getByTestId("room-title")).toBeVisible({ timeout: 30_000 });
  await page.waitForSelector('[data-testid="editor-area"] .monaco-editor .view-lines', { timeout: 60_000 });
  await expect(page.getByTestId("conn-pill")).toHaveAttribute("data-state", "connected", { timeout: 30_000 });
  await page.waitForTimeout(300); // binding attaches on first sync; give it a frame
}

/** Text of the room's main editor (not the AI diff editors), as rendered by Monaco. */
export async function roomEditorText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const editors = Array.from(document.querySelectorAll('[data-testid="editor-area"] .monaco-editor')).filter(
      (el) => !el.closest('[data-testid="ai-diff"]')
    );
    const ed = editors[0];
    if (!ed) return "";
    const lines = Array.from(ed.querySelectorAll(".view-lines .view-line")) as HTMLElement[];
    lines.sort((a, b) => parseFloat(a.style.top || "0") - parseFloat(b.style.top || "0"));
    return lines.map((el) => el.innerText.replace(/ /g, " ")).join("\n");
  });
}

export async function waitForEditorText(page: Page, pred: (t: string) => boolean, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let t = await roomEditorText(page);
  while (!pred(t) && Date.now() < deadline) {
    await page.waitForTimeout(150);
    t = await roomEditorText(page);
  }
  return t;
}

/** Click into the main editor and put the cursor at the end of line `n` (1-based). */
export async function editorLineEnd(page: Page, n: number) {
  await page.locator('[data-testid="editor-area"] .monaco-editor .view-lines').first().click();
  await page.keyboard.press("Control+Home");
  for (let i = 1; i < n; i++) await page.keyboard.press("ArrowDown");
  await page.keyboard.press("End");
}

/** Text rendered in the xterm output panel. */
export async function terminalText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const rows = document.querySelector('[data-testid="terminal"] .xterm-rows') as HTMLElement | null;
    return rows ? rows.innerText.replace(/ /g, " ") : "";
  });
}

/** Live document text on the sync cluster (via the LB, internal secret). */
export async function serverText(roomId: string): Promise<string> {
  const r = await fetch(`http://127.0.0.1:${LB_PORT}/room/${encodeURIComponent(roomId)}/text`, {
    headers: { "x-internal-secret": INTERNAL_SECRET },
  });
  return ((await r.json()) as any).content ?? "";
}
