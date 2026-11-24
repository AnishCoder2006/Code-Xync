import { Request, Response, NextFunction } from "express";
import { clerkClient, clerkMiddleware, getAuth } from "@clerk/express";
import { prisma } from "../lib/prisma";
import { ensureUser } from "../lib/userProvisioning";
import { logger } from "./logger";
import { User } from "@prisma/client";

// Extend Express Request
declare global {
  namespace Express {
    interface Request {
      user?: User;
    }
  }
}

export const attachUser = async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (process.env.NODE_ENV === "test") {
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith("Bearer test-token-")) {
        const uid = authHeader.replace("Bearer test-token-", "").trim();
        const user = await prisma.user.findUnique({ where: { id: uid } });
        if (user) {
          req.user = user;
          return next();
        }
      }
    }

    const auth = getAuth(req);
    const clerkId = auth.userId;
    
    if (!clerkId) {
      return next();
    }

    let user = await prisma.user.findUnique({ where: { id: clerkId } });
    if (!user) {
      // First request from this Clerk user: create the row (email optional, never a duplicate).
      user = await ensureUser(prisma, await clerkClient.users.getUser(clerkId));
    }

    req.user = user;
    next();
  } catch (error) {
    logger.error({ err: error }, "Failed to attach user");
    next(error);
  }
};

const clerk = clerkMiddleware();

/**
 * Router-level auth for every user-facing API route.
 * - Unauthenticated requests get 401 JSON (Clerk's deprecated requireAuth() answered
 *   with a 302 redirect to the sign-in page, which an API client cannot use).
 * - NODE_ENV=test only: "Authorization: Bearer test-token-<userId>" resolves to that
 *   user, and a user already attached by a test harness is kept. Never active otherwise.
 * - Otherwise: Clerk session (cookie or bearer) -> getAuth() -> attachUser.
 */
export const authenticate = async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (process.env.NODE_ENV === "test") {
      if (req.user) return next();
      const authHeader = req.get("authorization");
      if (authHeader?.startsWith("Bearer test-token-")) {
        const uid = authHeader.slice("Bearer test-token-".length).trim();
        const user = await prisma.user.findUnique({ where: { id: uid } });
        if (!user) return res.status(401).json({ error: "Unauthorized" });
        req.user = user;
        return next();
      }
      // Tests run without Clerk keys; nothing else can authenticate.
      if (!process.env.CLERK_SECRET_KEY) return res.status(401).json({ error: "Unauthorized" });
    }

    clerk(req, res, (err?: unknown) => {
      if (err) return next(err);
      if (!getAuth(req).userId) {
        logger.warn({ path: req.path }, "Unauthenticated request rejected");
        return res.status(401).json({ error: "Unauthorized" });
      }
      attachUser(req, res, next);
    });
  } catch (error) {
    next(error);
  }
};

export const requireAuthRole =(allowedRoles: string[]) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      logger.warn({ path: req.path }, "Unauthenticated request rejected");
      return res.status(401).json({ error: "Unauthorized" });
    }
    
    // For global user roles:
    if (allowedRoles.length > 0 && !allowedRoles.includes(req.user.role)) {
      logger.warn({ userId: req.user.id, role: req.user.role, path: req.path }, "RBAC rejection");
      return res.status(403).json({ error: "Forbidden" });
    }
    next();
  };
};
