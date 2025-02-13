/**
 * Instrumentation utilities for performance monitoring and tracing.
 */
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { envDetector, Resource } from "@opentelemetry/resources";
import { BatchLogRecordProcessor, LoggerProvider, } from "@opentelemetry/sdk-logs";
import { MeterProvider, PeriodicExportingMetricReader, } from "@opentelemetry/sdk-metrics";
import { AlwaysOnSampler, BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { metrics } from '@opentelemetry/api';
import { logs } from '@opentelemetry/api-logs';
import { ExpressInstrumentation } from "@opentelemetry/instrumentation-express";
import { PinoInstrumentation } from "@opentelemetry/instrumentation-pino";
let tracerProvider = null;
let meterProvider = null;
let loggerProvider = null;
let otelLogger = null;
let isInstrumentationInitialized = false;
instrumentApp().then(() => {
}).catch((error) => {
    console.error("Error initializing instrumentation:", error);
});
process.on("SIGINT", () => {
    shutdownInstrumentation().catch(error => {
        console.debug("Fatal error during shutdown:", error);
        process.exit(0);
    });
});
process.on("SIGTERM", () => {
    shutdownInstrumentation().catch(error => {
        console.debug("Fatal error during shutdown:", error);
        process.exit(0);
    });
});
/**
 * Retrieve authentication headers.
 */
async function authHeaders() {
    const getAuthenticationHeaders = await import("@beamlit/sdk/authentication/authentication.js");
    const headers = await getAuthenticationHeaders.getAuthenticationHeaders();
    return {
        "x-beamlit-authorization": headers?.["X-Beamlit-Authorization"] || "",
        "x-beamlit-workspace": headers?.["X-Beamlit-Workspace"] || "",
    };
}
/**
 * Initialize and return the LoggerProvider.
 */
export function getLoggerProviderInstance() {
    if (!loggerProvider) {
        throw new Error("LoggerProvider is not initialized");
    }
    return loggerProvider;
}
/**
 * Get resource attributes for OpenTelemetry.
 */
async function getResourceAttributes() {
    const resource = await envDetector.detect();
    return {
        ...resource.attributes,
        "service.name": process.env.BL_SERVICE_NAME,
        workspace: process.env.BL_WORKSPACE,
    };
}
/**
 * Initialize and return the OTLP Metric Exporter.
 */
async function getMetricExporter() {
    if (!process.env.BL_ENABLE_OPENTELEMETRY) {
        return null;
    }
    const headers = await authHeaders();
    return new OTLPMetricExporter({
        headers: headers,
    });
}
/**
 * Initialize and return the OTLP Trace Exporter.
 */
async function getTraceExporter() {
    if (!process.env.BL_ENABLE_OPENTELEMETRY) {
        return null;
    }
    const headers = await authHeaders();
    return new OTLPTraceExporter({
        headers: headers,
    });
}
/**
 * Initialize and return the OTLP Log Exporter.
 */
async function getLogExporter() {
    if (!process.env.BL_ENABLE_OPENTELEMETRY) {
        return null;
    }
    const headers = await authHeaders();
    return new OTLPLogExporter({
        headers: headers,
    });
}
export function getLogger() {
    if (!otelLogger) {
        throw new Error("Logger is not initialized");
    }
    return otelLogger;
}
/**
 * Instrument the Fastify application with OpenTelemetry.
 */
export async function instrumentApp() {
    if (!process.env.BL_ENABLE_OPENTELEMETRY || isInstrumentationInitialized) {
        return;
    }
    isInstrumentationInitialized = true;
    var instrumentations = [
        new HttpInstrumentation(),
        new ExpressInstrumentation(),
        new PinoInstrumentation(),
    ];
    const resource = new Resource(await getResourceAttributes());
    // Initialize Logger Provider with exporter
    const logExporter = await getLogExporter();
    if (!logExporter) {
        throw new Error("Log exporter is not initialized");
    }
    loggerProvider = new LoggerProvider({
        resource,
    });
    loggerProvider.addLogRecordProcessor(new BatchLogRecordProcessor(logExporter));
    logs.setGlobalLoggerProvider(loggerProvider);
    // Initialize Tracer Provider with exporter
    const traceExporter = await getTraceExporter();
    if (!traceExporter) {
        throw new Error("Trace exporter is not initialized");
    }
    tracerProvider = new NodeTracerProvider({
        resource,
        sampler: new AlwaysOnSampler(),
        spanProcessors: [new BatchSpanProcessor(traceExporter)],
    });
    tracerProvider.register(); // This registers it as the global tracer provider
    // Initialize Meter Provider with exporter
    const metricExporter = await getMetricExporter();
    if (!metricExporter) {
        throw new Error("Metric exporter is not initialized");
    }
    meterProvider = new MeterProvider({
        resource,
        readers: [
            new PeriodicExportingMetricReader({
                exporter: metricExporter,
                exportIntervalMillis: 60000,
            })
        ]
    });
    // Register as global meter provider
    metrics.setGlobalMeterProvider(meterProvider);
    registerInstrumentations({
        instrumentations: instrumentations,
    });
}
/**
 * Shutdown OpenTelemetry instrumentation.
 */
async function shutdownInstrumentation() {
    try {
        const shutdownPromises = [];
        if (tracerProvider) {
            shutdownPromises.push(tracerProvider.shutdown()
                .catch(error => console.debug("Error shutting down tracer provider:", error)));
        }
        if (meterProvider) {
            shutdownPromises.push(meterProvider.shutdown()
                .catch(error => console.debug("Error shutting down meter provider:", error)));
        }
        if (loggerProvider) {
            shutdownPromises.push(loggerProvider.shutdown()
                .catch(error => console.debug("Error shutting down logger provider:", error)));
        }
        // Wait for all providers to shutdown with a timeout
        await Promise.race([
            Promise.all(shutdownPromises),
            new Promise(resolve => setTimeout(resolve, 5000)) // 5 second timeout
        ]);
        process.exit(0);
    }
    catch (error) {
        console.error("Error during shutdown:", error);
        process.exit(1);
    }
}
