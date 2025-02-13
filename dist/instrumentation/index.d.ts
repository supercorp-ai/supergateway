import { LoggerProvider } from "@opentelemetry/sdk-logs";
import { Logger } from '@opentelemetry/api-logs';
/**
 * Initialize and return the LoggerProvider.
 */
export declare function getLoggerProviderInstance(): LoggerProvider;
export declare function getLogger(): Logger;
/**
 * Instrument the Fastify application with OpenTelemetry.
 */
export declare function instrumentApp(): Promise<void>;
