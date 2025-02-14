import { saveCredentials } from "./credentials.js";
import { Credentials } from "./types.js";

interface DeviceLoginFinalizeResponse {
  access_token: string;
  expires_in: number;
  refresh_token: string;
  token_type: string;
}

/**
 * Handles bearer token authentication, managing access tokens for device mode.
 */
export class BearerToken {
  private credentials: Credentials;
  private workspace_name: string;
  private base_url: string;

  /**
   * Constructs a new BearerToken instance.
   * @param credentials - The credentials containing access tokens.
   * @param workspace_name - The name of the workspace.
   * @param base_url - The base URL of the authentication server.
   */
  constructor(
    credentials: Credentials,
    workspace_name: string,
    base_url: string
  ) {
    this.credentials = credentials;
    this.workspace_name = workspace_name;
    this.base_url = base_url;
  }

  /**
   * Retrieves the authentication headers, refreshing tokens if necessary.
   * @returns A promise resolving to a record of header key-value pairs.
   * @throws If token refresh fails.
   */
  async getHeaders(): Promise<Record<string, string>> {
    const err = await this.refreshIfNeeded();
    if (err) {
      throw err;
    }
    return {
      "X-Beamlit-Authorization": `Bearer ${this.credentials.access_token}`,
      "X-Beamlit-Workspace": this.workspace_name,
    };
  }

  /**
   * Refreshes the access token if it's expired or about to expire.
   * @returns A promise resolving to null.
   * @throws If token refresh fails.
   */
  private async refreshIfNeeded(): Promise<null> {
    // Need to refresh token if expires in less than 10 minutes
    if (!this.credentials.access_token) {
      return await this.doRefresh();
    }

    const parts = this.credentials.access_token?.split(".") || [];
    if (parts.length !== 3) {
      return await this.doRefresh();
    }

    try {
      const claimsBytes = Buffer.from(parts[1], "base64url");
      const claims = JSON.parse(claimsBytes.toString());
      const expTime = new Date(claims.exp * 1000);
      const currentTime = new Date();

      // Refresh if token expires in less than 10 minutes
      if (currentTime.getTime() + 10 * 60 * 1000 > expTime.getTime()) {
        return await this.doRefresh();
      }
    } catch {
      return await this.doRefresh();
    }
    return null;
  }

  /**
   * Performs the token refresh by requesting new access tokens.
   * @returns A promise resolving to null.
   * @throws If the refresh process fails.
   */
  private async doRefresh(): Promise<null> {
    if (!this.credentials.refresh_token) {
      throw new Error("No refresh token to refresh");
    }

    const url = `${this.base_url}/oauth/token`;
    const refresh_data = {
      grant_type: "refresh_token",
      refresh_token: this.credentials.refresh_token,
      device_code: this.credentials.device_code,
      client_id: "beamlit",
    };

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(refresh_data),
      });

      const finalize_response =
        (await response.json()) as DeviceLoginFinalizeResponse;

      if (!finalize_response.refresh_token) {
        finalize_response.refresh_token = this.credentials.refresh_token;
      }

      const creds: Credentials = {
        access_token: finalize_response.access_token,
        refresh_token: finalize_response.refresh_token,
        expires_in: finalize_response.expires_in,
        device_code: this.credentials.device_code,
        apiKey: "",
        client_credentials: this.credentials.client_credentials,
      };

      this.credentials = creds;
      saveCredentials(this.workspace_name, creds);
      return null;
    } catch (e) {
      throw new Error(`Failed to refresh token: ${e}`);
    }
  }
}
