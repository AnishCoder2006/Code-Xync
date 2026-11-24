import Redis from "ioredis";
import { logger } from "../middleware/logger";

/**
 * Tell every sync node to drop a member's sockets in a room so they reconnect and the
 * node re-checks their role (services/sync/src/index.ts, "sync:control").
 * Best effort: a failure is logged; the role still applies on the member's next connect.
 */
const CHANNEL = "sync:control";
let pub: Redis | null = null;

export async function requestReauth(roomId: string, userId: string): Promise<number> {
  try {
    if (!pub) {
      pub = new Redis(process.env.REDIS_URL || "redis://localhost:6380", { maxRetriesPerRequest: 1 });
      pub.on("error", () => {});
    }
    return await pub.publish(CHANNEL, JSON.stringify({ type: "reauth", roomId, userId }));
  } catch (err) {
    logger.warn({ err, roomId, userId }, "Could not publish sync re-auth request");
    return 0;
  }
}
