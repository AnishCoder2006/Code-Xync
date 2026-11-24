/**
 * The sync service's OWN Prisma client (Phase 6 A1). Generated from
 * services/sync/prisma/schema.prisma in the Docker image; nothing is imported from
 * services/api.
 *
 * connectionTimeoutMillis: without it, pg waits forever for an unreachable database,
 * so a room load (and every client waiting on it) would hang instead of failing over
 * to the in-memory fallback.
 */
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const connectionString = process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/codesync";
const adapter = new PrismaPg({ connectionString, connectionTimeoutMillis: 5000 });
export const prisma = new PrismaClient({ adapter });
