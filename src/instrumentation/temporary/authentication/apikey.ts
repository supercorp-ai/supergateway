import { Credentials } from "./types.js";

/**
 * Handles API key authentication for Beamlit API requests.
 */
export class ApiKeyAuth {
  private credentials: Credentials;
  private workspaceName: string;

  /**
   * Constructs a new ApiKeyAuth instance.
   * @param credentials - The credentials containing the API key.
   * @param workspaceName - The name of the workspace.
   */
  constructor(credentials: Credentials, workspaceName: string) {
    this.credentials = credentials;
    this.workspaceName = workspaceName;
  }

  /**
   * Retrieves the authentication headers.
   * @returns A promise resolving to a record of header key-value pairs.
   */
  async getHeaders(): Promise<Record<string, string>> {
    return {
      "X-Beamlit-Api-Key": this.credentials.apiKey || "",
      // "X-Beamlit-Authorization": `Bearer ${this.credentials.apiKey || ""}`,
      "X-Beamlit-Workspace": this.workspaceName,
    };
  }

  /**
   * Intercepts and sets the authentication headers on a request.
   * @param req - The request to intercept and modify.
   */
  intercept(req: Request): void {
    req.headers.set("X-Beamlit-Api-Key", this.credentials.apiKey || "");
    req.headers.set("X-Beamlit-Workspace", this.workspaceName);
  }
}
