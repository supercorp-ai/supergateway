import { z } from "zod";
declare global {
    var SETTINGS: Settings | null;
}
/**
 * Schema for agent settings.
 */
declare const SettingsAgent: z.ZodObject<{
    agent: z.ZodDefault<z.ZodNullable<z.ZodAny>>;
    chain: z.ZodDefault<z.ZodNullable<z.ZodArray<z.ZodAny, "many">>>;
    model: z.ZodDefault<z.ZodNullable<z.ZodAny>>;
    functions: z.ZodDefault<z.ZodNullable<z.ZodArray<z.ZodAny, "many">>>;
    functionsDirectory: z.ZodDefault<z.ZodString>;
    chatModel: z.ZodDefault<z.ZodNullable<z.ZodAny>>;
    module: z.ZodDefault<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    chain: any[] | null;
    functions: any[] | null;
    functionsDirectory: string;
    module: string;
    agent?: any;
    model?: any;
    chatModel?: any;
}, {
    agent?: any;
    chain?: any[] | null | undefined;
    model?: any;
    functions?: any[] | null | undefined;
    functionsDirectory?: string | undefined;
    chatModel?: any;
    module?: string | undefined;
}>;
type SettingsAgentType = z.infer<typeof SettingsAgent>;
/**
 * Schema for authentication settings.
 */
declare const SettingsAuthentication: z.ZodObject<{
    apiKey: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    jwt: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    clientCredentials: z.ZodDefault<z.ZodNullable<z.ZodString>>;
}, "strip", z.ZodTypeAny, {
    apiKey: string | null;
    jwt: string | null;
    clientCredentials: string | null;
}, {
    apiKey?: string | null | undefined;
    jwt?: string | null | undefined;
    clientCredentials?: string | null | undefined;
}>;
type SettingsAuthenticationType = z.infer<typeof SettingsAuthentication>;
/**
 * Schema for server settings.
 */
declare const SettingsServer: z.ZodObject<{
    module: z.ZodDefault<z.ZodString>;
    port: z.ZodDefault<z.ZodNumber>;
    host: z.ZodDefault<z.ZodString>;
    directory: z.ZodDefault<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    port: number;
    module: string;
    host: string;
    directory: string;
}, {
    port?: number | undefined;
    module?: string | undefined;
    host?: string | undefined;
    directory?: string | undefined;
}>;
type SettingsServerType = z.infer<typeof SettingsServer>;
/**
 * Schema for overall settings.
 */
declare const Settings: z.ZodObject<{
    workspace: z.ZodString;
    environment: z.ZodDefault<z.ZodString>;
    remote: z.ZodDefault<z.ZodBoolean>;
    type: z.ZodDefault<z.ZodString>;
    name: z.ZodDefault<z.ZodString>;
    baseUrl: z.ZodDefault<z.ZodString>;
    appUrl: z.ZodDefault<z.ZodString>;
    runUrl: z.ZodDefault<z.ZodString>;
    registryUrl: z.ZodDefault<z.ZodString>;
    logLevel: z.ZodDefault<z.ZodString>;
    enableOpentelemetry: z.ZodDefault<z.ZodBoolean>;
    agent: z.ZodDefault<z.ZodObject<{
        agent: z.ZodDefault<z.ZodNullable<z.ZodAny>>;
        chain: z.ZodDefault<z.ZodNullable<z.ZodArray<z.ZodAny, "many">>>;
        model: z.ZodDefault<z.ZodNullable<z.ZodAny>>;
        functions: z.ZodDefault<z.ZodNullable<z.ZodArray<z.ZodAny, "many">>>;
        functionsDirectory: z.ZodDefault<z.ZodString>;
        chatModel: z.ZodDefault<z.ZodNullable<z.ZodAny>>;
        module: z.ZodDefault<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        chain: any[] | null;
        functions: any[] | null;
        functionsDirectory: string;
        module: string;
        agent?: any;
        model?: any;
        chatModel?: any;
    }, {
        agent?: any;
        chain?: any[] | null | undefined;
        model?: any;
        functions?: any[] | null | undefined;
        functionsDirectory?: string | undefined;
        chatModel?: any;
        module?: string | undefined;
    }>>;
    server: z.ZodDefault<z.ZodObject<{
        module: z.ZodDefault<z.ZodString>;
        port: z.ZodDefault<z.ZodNumber>;
        host: z.ZodDefault<z.ZodString>;
        directory: z.ZodDefault<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        port: number;
        module: string;
        host: string;
        directory: string;
    }, {
        port?: number | undefined;
        module?: string | undefined;
        host?: string | undefined;
        directory?: string | undefined;
    }>>;
    authentication: z.ZodDefault<z.ZodObject<{
        apiKey: z.ZodDefault<z.ZodNullable<z.ZodString>>;
        jwt: z.ZodDefault<z.ZodNullable<z.ZodString>>;
        clientCredentials: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    }, "strip", z.ZodTypeAny, {
        apiKey: string | null;
        jwt: string | null;
        clientCredentials: string | null;
    }, {
        apiKey?: string | null | undefined;
        jwt?: string | null | undefined;
        clientCredentials?: string | null | undefined;
    }>>;
    deploy: z.ZodDefault<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    type: string;
    name: string;
    workspace: string;
    environment: string;
    remote: boolean;
    agent: {
        chain: any[] | null;
        functions: any[] | null;
        functionsDirectory: string;
        module: string;
        agent?: any;
        model?: any;
        chatModel?: any;
    };
    baseUrl: string;
    appUrl: string;
    runUrl: string;
    registryUrl: string;
    logLevel: string;
    enableOpentelemetry: boolean;
    server: {
        port: number;
        module: string;
        host: string;
        directory: string;
    };
    authentication: {
        apiKey: string | null;
        jwt: string | null;
        clientCredentials: string | null;
    };
    deploy: boolean;
}, {
    workspace: string;
    type?: string | undefined;
    name?: string | undefined;
    environment?: string | undefined;
    remote?: boolean | undefined;
    agent?: {
        agent?: any;
        chain?: any[] | null | undefined;
        model?: any;
        functions?: any[] | null | undefined;
        functionsDirectory?: string | undefined;
        chatModel?: any;
        module?: string | undefined;
    } | undefined;
    baseUrl?: string | undefined;
    appUrl?: string | undefined;
    runUrl?: string | undefined;
    registryUrl?: string | undefined;
    logLevel?: string | undefined;
    enableOpentelemetry?: boolean | undefined;
    server?: {
        port?: number | undefined;
        module?: string | undefined;
        host?: string | undefined;
        directory?: string | undefined;
    } | undefined;
    authentication?: {
        apiKey?: string | null | undefined;
        jwt?: string | null | undefined;
        clientCredentials?: string | null | undefined;
    } | undefined;
    deploy?: boolean | undefined;
}>;
type Settings = z.infer<typeof Settings>;
/**
 * Retrieves the current settings, initializing if not already done.
 * @returns The current settings object.
 */
declare function getSettings(): Settings;
/**
 * Initializes the settings by merging configurations from YAML, environment variables, and options.
 * @param options - Optional settings to override defaults.
 * @returns The initialized settings object.
 */
declare function init(options?: Partial<Settings>): Settings;
export { getSettings, init, Settings, SettingsAgent, SettingsAuthentication, SettingsServer, type SettingsAgentType, type SettingsAuthenticationType, type SettingsServerType, type Settings as SettingsType, };
