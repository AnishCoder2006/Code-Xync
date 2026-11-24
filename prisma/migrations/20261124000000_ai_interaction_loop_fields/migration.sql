-- Phase 5 added these AIInteraction columns with `prisma db push` only, so a database
-- built from migrations (CI, a new environment) lacked them. Captured here (Phase 6 A1).
-- AlterTable
ALTER TABLE "AIInteraction" ADD COLUMN     "attempts" INTEGER,
ADD COLUMN     "baseContent" TEXT,
ADD COLUMN     "timings" JSONB;
