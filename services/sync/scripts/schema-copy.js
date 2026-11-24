/**
 * The sync service builds its own Prisma client (Phase 6 A1) from
 * services/sync/prisma/schema.prisma so its Docker image needs nothing outside
 * services/sync. That file is a byte-for-byte copy of the root prisma/schema.prisma
 * (the single source of truth for migrations).
 *   node scripts/schema-copy.js          copy root -> services/sync/prisma
 *   node scripts/schema-copy.js --check  exit 1 if the copy differs (CI)
 */
const fs = require("fs");
const path = require("path");
const root = path.resolve(__dirname, "../../../prisma/schema.prisma");
const local = path.resolve(__dirname, "../prisma/schema.prisma");
const want = fs.readFileSync(root);
if (process.argv.includes("--check")) {
  const have = fs.existsSync(local) ? fs.readFileSync(local) : Buffer.alloc(0);
  if (!have.equals(want)) {
    console.error("services/sync/prisma/schema.prisma differs from prisma/schema.prisma. Run: npm run prisma:copy-schema");
    process.exit(1);
  }
  console.log("services/sync/prisma/schema.prisma matches prisma/schema.prisma");
} else {
  fs.mkdirSync(path.dirname(local), { recursive: true });
  fs.writeFileSync(local, want);
  console.log("copied prisma/schema.prisma -> services/sync/prisma/schema.prisma");
}
