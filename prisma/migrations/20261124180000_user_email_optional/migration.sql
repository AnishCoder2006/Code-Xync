-- GitHub (and other) sign-ins may share no email; NULLs do not collide under the unique index.
ALTER TABLE "User" ALTER COLUMN "email" DROP NOT NULL;
