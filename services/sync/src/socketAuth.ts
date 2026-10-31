import { createClerkClient } from "@clerk/backend";
import { prisma } from "./lib/prisma";
import type { IncomingMessage } from "http";
import * as urlModule from "url";

const clerk = createClerkClient({
  secretKey: process.env.CLERK_SECRET_KEY,
  publishableKey: process.env.CLERK_PUBLISHABLE_KEY,
});

export const authenticateSocket = async (
  req: IncomingMessage
): Promise<{ userId: string; roomId: string }> => {
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
      // authenticateRequest is the correct Clerk v5 API for verifying a session JWT
      const requestState = await clerk.authenticateRequest(
        new Request(`https://placeholder.local/?__session=${encodeURIComponent(token)}`),
        { secretKey: process.env.CLERK_SECRET_KEY }
      );

      if (!requestState.isSignedIn || !requestState.toAuth().userId) {
        throw new Error("Invalid token");
      }
      userId = requestState.toAuth().userId!;
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

    return { userId, roomId };
  } catch (err) {
    throw new Error("Authentication failed");
  }
};
