import { Credentials } from "./types.js";
/**
 * Handles client credentials authentication, managing access and refresh tokens.
 */
export declare class ClientCredentials {
    private credentials;
    private workspace_name;
    private base_url;
    /**
     * Constructs a new ClientCredentials instance.
     * @param credentials - The credentials containing client credentials and tokens.
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
     * @returns A promise resolving to null, or an error if refresh fails.
     * @throws If token refresh fails.
     */
    refreshIfNeeded(): Promise<null>;
    /**
     * Intercepts a request, setting the appropriate authentication headers.
     * @param req - The request to intercept and modify.
     * @throws If token refresh fails.
     */
    intercept(req: Request): void;
    /**
     * Performs the token refresh by requesting new access and refresh tokens.
     * @returns A promise resolving to null.
     * @throws If the refresh process fails.
     */
    private doRefresh;
}
