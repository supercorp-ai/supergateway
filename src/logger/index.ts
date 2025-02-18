import { logs } from "@opentelemetry/api-logs";
import { pino } from "pino";

/**
 * Lazy-initialized singleton logger instance.
 */
export const logger = new Proxy({} as any, {
  get: (target, property) => {
    const loggerConfiguration = {
      level: process.env.BL_LOG_LEVEL || "info",
      transport: {
        target: "pino-pretty",
        options: {
          colorizeObjects: false,
          translateTime: false,
          hideObject: true,
          messageFormat: "\x1B[37m{msg}",
          ignore: "pid,hostname,time",
        },
      },
    };

    // Only create instance if it doesn't exist
    if (!(target as any).__instance) {
      const instance = pino(loggerConfiguration);
      (target as any).__instance = instance;

      // Get OpenTelemetry logger
      try {
        const otelLogger = logs.getLogger("blaxel");
        if (otelLogger) {
          (target as any).__otelLogger = otelLogger;
        }
      } catch (e) {
        // OpenTelemetry logger not available
      }
    }

    // Try to use OpenTelemetry logger if available
    if ((target as any).__otelLogger && property in (target as any).__otelLogger) {
      return (target as any).__otelLogger[property];
    }
    
    return (target as any).__instance[property];
  }
});

export const log = {
  info: async (msg: string, ...args: any[]) => {
    const loggerInstance = await (logger as any).info;
    loggerInstance(msg, ...args);
  },
  error: async (msg: string, ...args: any[]) => {
    const loggerInstance = await (logger as any).error;
    loggerInstance(msg, ...args);
  },
  warn: async (msg: string, ...args: any[]) => {
    const loggerInstance = await (logger as any).warn;
    loggerInstance(msg, ...args);
  },
  debug: async (msg: string, ...args: any[]) => {
    const loggerInstance = await (logger as any).debug;
    loggerInstance(msg, ...args);
  }
};