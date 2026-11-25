import { verifyToken } from "@clerk/backend";
import { prisma } from "./lib/prisma";
import type { IncomingMessage } from "http";
import * as urlModule from "url";

export const authenticateSocket = async (
  req: IncomingMessage
): Promise<{ userId: string; roomId: string; role: "OWNER" | "EDITOR" | "VIEWER" }> => {
  const parsedUrl = urlModule.parse(req.url || "", true);
  const token = parsedUrl.query.token as string;
  const roomId = parsedUrl.query.roomId as string;

  if (!token || !roomId) {
    throw new Error("Missing token or roomId");
  }

  try {
    let userId: string;

    if (process.env.NODE_ENV === "test" && token.startsWith("test-token-")) {
      userId = token.replace("test-token-", "");
    } else {
      // Browsers cannot set headers on a WebSocket, so the session JWT arrives as ?token=.
      // Verify it directly: authenticateRequest() only reads cookies / the Authorization
      // header and, in development, rejects header-less requests (dev-browser-missing).
      const payload = await verifyToken(token, { secretKey: process.env.CLERK_SECRET_KEY });
      if (!payload.sub) throw new Error("Invalid token");
      userId = payload.sub;
    }

    const member = await prisma.roomMember.findUnique({
      where: {
        roomId_userId: {
          roomId,
          userId,
        },
      },
    });

    if (!member) {
      throw new Error("User is not a member of the room");
    }

    return { userId, roomId, role: member.role };
  } catch (err) {
    console.warn(`[sync] socket auth rejected: ${(err as Error).message}`);
    throw new Error("Authentication failed");
  }
};
