// Seed script — populate a demo user + room for local development.
// Run with: npx prisma db seed
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

async function main() {
  // TODO: create a demo user and room once auth (Clerk) is wired up.
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
