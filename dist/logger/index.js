import { logs } from "@opentelemetry/api-logs";
import { pino } from "pino";
/**
 * Lazy-initialized singleton logger instance.
 */
export const logger = new Proxy({}, {
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
        if (!target.__instance) {
            const instance = pino(loggerConfiguration);
            target.__instance = instance;
            // Get OpenTelemetry logger
            try {
                const otelLogger = logs.getLogger("blaxel");
                if (otelLogger) {
                    target.__otelLogger = otelLogger;
                }
            }
            catch (e) {
                // OpenTelemetry logger not available
            }
        }
        // Try to use OpenTelemetry logger if available
        if (target.__otelLogger && property in target.__otelLogger) {
            return target.__otelLogger[property];
        }
        return target.__instance[property];
    }
});
export const log = {
    info: async (msg, ...args) => {
        const loggerInstance = await logger.info;
        loggerInstance(msg, ...args);
    },
    error: async (msg, ...args) => {
        const loggerInstance = await logger.error;
        loggerInstance(msg, ...args);
    },
    warn: async (msg, ...args) => {
        const loggerInstance = await logger.warn;
        loggerInstance(msg, ...args);
    },
    debug: async (msg, ...args) => {
        const loggerInstance = await logger.debug;
        loggerInstance(msg, ...args);
    }
};
