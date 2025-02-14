import { Credentials } from "./types.js";
interface RunClientWithCredentials {
    credentials: Credentials;
    workspace: string;
    apiUrl?: string;
    runUrl?: string;
}
/**
 * Creates a new client based on the provided settings.
 * @param settings - The current application settings.
 * @returns A new client instance.
 */
export declare function newClientFromSettings(settings: any): import("@hey-api/client-fetch").Client;
/**
 * Creates a new client using the current client configuration.
 * @returns A new client instance.
 */
export declare function newClient(): import("@hey-api/client-fetch").Client;
/**
 * Creates a new client with the specified credentials.
 * @param config - The client configuration.
 * @returns A new client instance.
 */
export declare function newClientWithCredentials(config: RunClientWithCredentials): import("@hey-api/client-fetch").Client;
/**
 * Retrieves the authentication headers for the current client configuration.
 * @returns A promise resolving to a record of header key-value pairs.
 */
export declare function getAuthenticationHeaders(): Promise<Record<string, string>>;
export {};
