/**
 * Handles API key authentication for blaxel API requests.
 */
export class ApiKeyAuth {
    credentials;
    workspaceName;
    /**
     * Constructs a new ApiKeyAuth instance.
     * @param credentials - The credentials containing the API key.
     * @param workspaceName - The name of the workspace.
     */
    constructor(credentials, workspaceName) {
        this.credentials = credentials;
        this.workspaceName = workspaceName;
    }
    /**
     * Retrieves the authentication headers.
     * @returns A promise resolving to a record of header key-value pairs.
     */
    async getHeaders() {
        return {
            "X-blaxel-Api-Key": this.credentials.apiKey || "",
            // "X-blaxel-Authorization": `Bearer ${this.credentials.apiKey || ""}`,
            "X-blaxel-Workspace": this.workspaceName,
        };
    }
    /**
     * Intercepts and sets the authentication headers on a request.
     * @param req - The request to intercept and modify.
     */
    intercept(req) {
        req.headers.set("X-blaxel-Api-Key", this.credentials.apiKey || "");
        req.headers.set("X-blaxel-Workspace", this.workspaceName);
    }
}
