import { Credentials } from "./types.js";
/**
 * Handles API key authentication for Beamlit API requests.
 */
export declare class ApiKeyAuth {
    private credentials;
    private workspaceName;
    /**
     * Constructs a new ApiKeyAuth instance.
     * @param credentials - The credentials containing the API key.
     * @param workspaceName - The name of the workspace.
     */
    constructor(credentials: Credentials, workspaceName: string);
    /**
     * Retrieves the authentication headers.
     * @returns A promise resolving to a record of header key-value pairs.
     */
    getHeaders(): Promise<Record<string, string>>;
    /**
     * Intercepts and sets the authentication headers on a request.
     * @param req - The request to intercept and modify.
     */
    intercept(req: Request): void;
}
