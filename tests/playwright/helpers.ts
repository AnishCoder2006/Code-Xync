/**
 * Shared helpers for the real-browser suite (tests/playwright).
 * These tests drive Chromium against /e2e/editor (the real Editor + Monaco + y-monaco)
 * served by a NEXT_PUBLIC_E2E=1 build, talking to real sync nodes.
 */
import { spawn, ChildProcess, execSync } from "child_process";
import path from "path";
import { Page } from "@playwright/test";
import * as Y from "yjs";
import { prisma } from "../../services/api/src/lib/prisma";

export const ROOT = path.resolve(__dirname, "../..");
export const SYNC_DIST = path.join(ROOT, "services/sync/dist/index.js");
export const LB_DIST = path.join(ROOT, "services/sync/dist/lb-proxy.js");
export const INTERNAL_SECRET = "codesync-internal-ai-secret";
export const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 3100);
export const WEB_URL = process.env.WEB_URL ?? `http://localhost:${WEB_PORT}`;

// Shared cluster started by global-setup.ts
export const PORT_NODE1 = 4041;
export const PORT_NODE2 = 4042;
export const LB_PORT = 4040;

export const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const uid = () => Math.random().toString(36).slice(2, 10);

export function killProc(proc: ChildProcess | null | undefined) {
  if (!proc?.pid) return;
  try {
    if (process.platform === "win32") execSync(`taskkill /pid ${proc.pid} /T /F`, { stdio: "ignore" });
    else proc.kill("SIGKILL");
  } catch {}
}

export function startNode(port: number, nodeId: string, extraEnv: Record<string, string> = {}): Promise<ChildProcess> {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [SYNC_DIST], {
      env: {
        ...process.env,
        SYNC_PORT: String(port),
        NODE_ID: nodeId,
        NODE_ENV: "test",
        INTERNAL_API_SECRET: INTERNAL_SECRET,
        ...extraEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let done = false;
    proc.stdout?.on("data", (d: Buffer) => {
      if (!done && d.toString().includes(`running on :${port}`)) {
        done = true;
        resolve(proc);
      }
    });
    proc.stderr?.on("data", () => {});
    setTimeout(() => !done && resolve(proc), 6000);
  });
}

export function startLB(lbPort: number, backends: number[]): Promise<{ proc: ChildProcess; log: string[] }> {
  return new Promise((resolve) => {
    const log: string[] = [];
    const proc = spawn(process.execPath, [LB_DIST], {
      env: {
        ...process.env,
        LB_PORT: String(lbPort),
        LB_HEALTH_INTERVAL_MS: "500",
        SYNC_BACKENDS: backends.map((p) => `127.0.0.1:${p}`).join(","),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let done = false;
    proc.stdout?.on("data", (d: Buffer) => {
      const s = d.toString();
      log.push(...s.split("\n").filter(Boolean));
      if (!done && s.includes("Load balancer listening")) {
        done = true;
        resolve({ proc, log });
      }
    });
    setTimeout(() => !done && resolve({ proc, log }), 4000);
  });
}

/** Create users + a room; optionally pre-seed the document text in Postgres. */
export async function seedRoom(roomId: string, users: string[], initialText?: string) {
  for (const u of users) {
    await prisma.user.upsert({ where: { id: u }, create: { id: u, email: `${u}@test.com`, name: u }, update: {} });
  }
  await prisma.room.create({
    data: {
      id: roomId,
      title: roomId,
      ownerId: users[0],
      members: { create: users.map((u, i) => ({ userId: u, role: i === 0 ? ("OWNER" as const) : ("EDITOR" as const) })) },
    },
  });
  if (initialText !== undefined) {
    const d = new Y.Doc();
    d.getText("content").insert(0, initialText);
    await prisma.projectFile.create({
      data: { roomId, path: "main.ts", language: "typescript", yjsState: Buffer.from(Y.encodeStateAsUpdate(d)) },
    });
  }
}

/** Per-room client count on one node (needs the internal secret for room detail). */
export async function roomClientsOn(port: number, roomId: string): Promise<number> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { headers: { "x-internal-secret": INTERNAL_SECRET } });
    const h = (await r.json()) as any;
    return h.roomDetails?.[roomId]?.clients ?? 0;
  } catch {
    return -1; // node down
  }
}

export const editorUrl = (roomId: string, userId: string, syncPort: number) =>
  `${WEB_URL}/e2e/editor?room=${encodeURIComponent(roomId)}&uid=${encodeURIComponent(userId)}&syncUrl=${encodeURIComponent(
    `ws://127.0.0.1:${syncPort}`
  )}`;

/** Open the e2e editor and wait until Monaco is mounted and the provider has synced. */
export async function openEditor(page: Page, roomId: string, userId: string, syncPort: number) {
  await page.goto(editorUrl(roomId, userId, syncPort));
  await page.waitForSelector(".monaco-editor .view-lines", { timeout: 60_000 });
  await page.waitForFunction(() => window.__e2e?.synced === true && window.__e2e?.status === "connected", null, {
    timeout: 30_000,
  });
  // The binding attaches on the provider's first "sync"; give it a frame to render.
  await page.waitForTimeout(200);
}

/** Text as rendered in the Monaco DOM (non-breaking spaces normalised). */
export async function getEditorText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const lines = Array.from(document.querySelectorAll(".monaco-editor .view-lines .view-line")) as HTMLElement[];
    // Monaco positions lines absolutely; order by their top offset.
    lines.sort((a, b) => parseFloat(a.style.top || "0") - parseFloat(b.style.top || "0"));
    return lines.map((el) => el.innerText.replace(/ /g, " ")).join("\n");
  });
}

/** Wait until the DOM text satisfies `pred`; returns the final text. */
export async function waitForText(page: Page, pred: (t: string) => boolean, timeoutMs = 15_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let t = await getEditorText(page);
  while (!pred(t) && Date.now() < deadline) {
    await page.waitForTimeout(100);
    t = await getEditorText(page);
  }
  return t;
}

/** Focus the editor and put the cursor at the end of line `lineNo` (1-based). */
export async function gotoLineEnd(page: Page, lineNo: number) {
  await page.locator(".monaco-editor .view-lines").first().click();
  await page.keyboard.press("Control+Home");
  for (let i = 1; i < lineNo; i++) await page.keyboard.press("ArrowDown");
  await page.keyboard.press("End");
}

/** Focus the editor and put the cursor at the very end of the document. */
export async function gotoDocEnd(page: Page) {
  await page.locator(".monaco-editor .view-lines").first().click();
  await page.keyboard.press("Control+End");
}

/** Type like a user, one key at a time. */
export async function typeText(page: Page, text: string, delay = 25) {
  await page.keyboard.type(text, { delay });
}

export const pageState = (page: Page) =>
  page.evaluate(() => ({ ...(window.__e2e as any) })) as Promise<{
    pageLoadId: string;
    status: string;
    synced: boolean;
    connects: number;
    disconnects: number;
  }>;

declare global {
  interface Window {
    __e2e?: { pageLoadId: string; status: string; synced: boolean; connects: number; disconnects: number };
  }
}
