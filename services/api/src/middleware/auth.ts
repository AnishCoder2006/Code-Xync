import { Request, Response, NextFunction } from "express";
import { clerkClient, getAuth } from "@clerk/express";
import { prisma } from "../lib/prisma";
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
    const auth = getAuth(req);
    const clerkId = auth.userId;
    
    if (!clerkId) {
      return next();
    }

    let user = await prisma.user.findUnique({ where: { id: clerkId } });
    if (!user) {
      // Fetch user from clerk to get email
      const clerkUser = await clerkClient.users.getUser(clerkId);
      const email = clerkUser.emailAddresses[0]?.emailAddress || `${clerkId}@placeholder.com`;
      
      user = await prisma.user.create({
        data: {
          id: clerkId,
          email: email,
          name: clerkUser.firstName ? `${clerkUser.firstName} ${clerkUser.lastName}` : "Unknown User"
        }
      });
    }

    req.user = user;
    next();
  } catch (error) {
    logger.error({ err: error }, "Failed to attach user");
    next(error);
  }
};

export const requireAuthRole = (allowedRoles: string[]) => {
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
