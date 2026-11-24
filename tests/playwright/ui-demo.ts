/**
 * Local UI preview WITHOUT Clerk keys: starts the same stack as the UI suite (E2E build with
 * test auth, 2 sync nodes + LB, API, AI service on the mock LLM, worker + Docker sandbox),
 * seeds two demo users and two rooms, prints links, and runs until Ctrl+C.
 *
 *   cd tests/playwright && npx tsx ui-demo.ts
 *
 * Needs: Docker (Postgres :5432, Redis :6380, sandbox images), services/ai/.venv.
 * Identity comes from the link (?as=<user>): open the second link in another browser
 * profile or a private window to collaborate as the other person.
 * For the real product with Clerk sign-in, see apps/web (npm run dev with your keys).
 */
process.env.NODE_ENV = "test";
import uiSetup from "./ui-global-setup";
import uiTeardown from "./ui-global-teardown";
import { appUrl, seedRoom, seedUsers } from "./ui-helpers";
import { prisma } from "../../services/api/src/lib/prisma";

const ANA = { id: "demo-ana", name: "Ana Silva" };
const RAJ = { id: "demo-raj", name: "Raj Patel" };
const ROOMS = [
  {
    id: "demo-pagination",
    title: "Pagination bug hunt",
    language: "python" as const,
    members: [[ANA.id, "OWNER"], [RAJ.id, "EDITOR"]] as [string, "OWNER" | "EDITOR" | "VIEWER"][],
    text:
      'def page_offset(page, size):\n    """Offset of the first item on a 1-indexed page."""\n    return page * size\n\n\n' +
      "print(page_offset(1, 10))  # expected 0\nprint(page_offset(3, 10))  # expected 20\n",
  },
  {
    id: "demo-greeter",
    title: "Greeter (Raj's room, Ana views)",
    language: "javascript" as const,
    members: [[RAJ.id, "OWNER"], [ANA.id, "VIEWER"]] as [string, "OWNER" | "EDITOR" | "VIEWER"][],
    text: 'function greet(name) {\n  return "Hello, " + name + "!";\n}\n\nconsole.log(greet("CodeSync"));\n',
  },
];

async function main() {
  await uiSetup();
  await seedUsers([ANA, RAJ]);
  for (const r of ROOMS) {
    if (!(await prisma.room.findUnique({ where: { id: r.id } }))) await seedRoom(r);
  }

  const line = "─".repeat(78);
  console.log(`\n${line}\n CodeSync is running (test auth, mock AI). Open:\n${line}`);
  console.log(` Landing (signed out)  ${appUrl("/")}`);
  console.log(` Ana's dashboard       ${appUrl("/rooms", ANA)}`);
  console.log(` Raj (2nd browser)     ${appUrl("/rooms", RAJ)}`);
  console.log(` Room as Ana           ${appUrl(`/room/${ROOMS[0].id}`, ANA)}`);
  console.log(` Room as Raj           ${appUrl(`/room/${ROOMS[0].id}`, RAJ)}`);
  console.log(` Viewer mode (Ana)     ${appUrl(`/room/${ROOMS[1].id}`, ANA)}`);
  console.log(`${line}`);
  console.log(" AI fix with the mock LLM: put a tag in the prompt, e.g.");
  console.log("   page_offset is off by one page [[b6:mixed:page_offset:try1]]");
  console.log("   (mixed = 1st answer malformed, then a retry; use a new last part each time)");
  console.log(` Ctrl+C stops everything.\n${line}\n`);

  const stop = async () => {
    console.log("\nStopping…");
    await uiTeardown();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  setInterval(() => {}, 1 << 30); // keep alive
}

main().catch(async (err) => {
  console.error(err);
  await uiTeardown().catch(() => {});
  process.exit(1);
});
