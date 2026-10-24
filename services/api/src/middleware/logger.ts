import pino from "pino";
import pinoHttp from "pino-http";
import { v4 as uuidv4 } from "uuid";
import { Request, Response } from "express";

export const logger = pino({
  level: process.env.LOG_LEVEL || "info",
});

export const loggerMiddleware = pinoHttp({
  logger,
  genReqId: (req: any) => req.headers["x-request-id"] || uuidv4(),
  customProps: (req: Request, res: Response) => {
    return {
      userId: (req as any).user?.id,
    };
  }
});
