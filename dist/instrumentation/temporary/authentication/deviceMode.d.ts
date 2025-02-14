import { Credentials } from "./types.js";
/**
 * Handles bearer token authentication, managing access tokens for device mode.
 */
export declare class BearerToken {
    private credentials;
    private workspace_name;
    private base_url;
    /**
     * Constructs a new BearerToken instance.
     * @param credentials - The credentials containing access tokens.
     * @param workspace_name - The name of the workspace.
     * @param base_url - The base URL of the authentication server.
     */
    constructor(credentials: Credentials, workspace_name: string, base_url: string);
    /**
     * Retrieves the authentication headers, refreshing tokens if necessary.
     * @returns A promise resolving to a record of header key-value pairs.
     * @throws If token refresh fails.
     */
    getHeaders(): Promise<Record<string, string>>;
    /**
     * Refreshes the access token if it's expired or about to expire.
     * @returns A promise resolving to null.
     * @throws If token refresh fails.
     */
    private refreshIfNeeded;
    /**
     * Performs the token refresh by requesting new access tokens.
     * @returns A promise resolving to null.
     * @throws If the refresh process fails.
     */
    private doRefresh;
}
