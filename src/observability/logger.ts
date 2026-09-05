import pino from "pino";
import { config } from "../config/env.js";
import { toLocalISO } from "../db/row-helpers.js";

const loggerOptions = {
  level: config.LOG_LEVEL,
  base: {
    service: "sag"
  },
  // pino's default timestamp uses `new Date().toISOString()` which always
  // outputs UTC. Use toLocalISO() (from row-helpers) so the log's `time`
  // field is in Asia/Shanghai (UTC+8) with a "+08:00" offset.
  timestamp: () => `,"time":"${toLocalISO()}"`,
};

export const logger = process.env.SAG_LOG_STDERR === "true"
  ? pino(loggerOptions, pino.destination(2))
  : pino(loggerOptions);