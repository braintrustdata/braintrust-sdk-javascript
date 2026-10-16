import { debugLogger } from "../src/debug-logger";
import { z } from "zod/v3";
import { Request, Response, ErrorRequestHandler, NextFunction } from "express";
import { HttpError } from "http-errors";

export const errorHandler: ErrorRequestHandler = (
  err: Error | HttpError,
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  if ("status" in err) {
    res.status(err.status).json({
      error: {
        message: err.message,
        status: err.status,
      },
    });
    return;
  }
  if (err instanceof z.ZodError) {
    res.status(400).json({
      error: {
        message: "Invalid request",
        errors: err.errors,
      },
    });
    return;
  }

  debugLogger.notice.error("Internal server error", err);
  res.status(500).json({
    error: {
      message: "Internal server error",
      status: 500,
    },
  });
};
