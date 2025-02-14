import { createClient, createConfig } from "@hey-api/client-fetch";
import { getSettings } from "../common/settings.js";
import { ApiKeyAuth } from "./apikey.js";
import { ClientCredentials } from "./clientcredentials.js";
import {
  currentContext,
  loadCredentials,
  loadCredentialsFromSettings,
} from "./credentials.js";
import { BearerToken } from "./deviceMode.js";
import { Credentials } from "./types.js";

interface RunClientWithCredentials {
  credentials: Credentials;
  workspace: string;
  apiUrl?: string;
  runUrl?: string;
}

/**
 * Handles public authentication when no credentials are provided.
 */
class PublicAuth {
  /**
   * Retrieves the authentication headers. For public access, returns an empty record.
   * @returns A promise resolving to an empty headers object.
   */
  async getHeaders(): Promise<Record<string, string>> {
    return {};
  }

  /**
   * Intercepts a request without modifying it, as public access requires no headers.
   */
  intercept(): void {}
}

/**
 * Creates a new client based on the provided settings.
 * @param settings - The current application settings.
 * @returns A new client instance.
 */
export function newClientFromSettings(settings: any) {
  const credentials = loadCredentialsFromSettings(settings);

  const clientConfig: RunClientWithCredentials = {
    credentials,
    workspace: settings.workspace,
  };
  return newClientWithCredentials(clientConfig);
}

/**
 * Retrieves the client configuration based on the current context.
 * @returns The client configuration object.
 */
function getClientConfig() {
  const context = currentContext();
  let clientConfig: RunClientWithCredentials;

  if (context.workspace) {
    const credentials = loadCredentials(context.workspace);
    clientConfig = {
      credentials,
      workspace: context.workspace,
    };
  } else {
    const settings = getSettings();
    const credentials = loadCredentialsFromSettings(settings);
    clientConfig = {
      credentials,
      workspace: settings.workspace,
    };
  }
  return clientConfig;
}

/**
 * Creates a new client using the current client configuration.
 * @returns A new client instance.
 */
export function newClient() {
  const clientConfig = getClientConfig();
  const client = newClientWithCredentials(clientConfig);
  return client;
}

/**
 * Determines the appropriate authentication provider based on the client configuration.
 * @param config - The client configuration.
 * @returns An instance of an authentication provider.
 */
function getProvider(config: RunClientWithCredentials) {
  let provider: ApiKeyAuth | BearerToken | ClientCredentials | PublicAuth;
  const settings = getSettings();

  if (config.credentials.apiKey) {
    provider = new ApiKeyAuth(config.credentials, config.workspace);
  } else if (
    config.credentials.access_token ||
    config.credentials.refresh_token
  ) {
    provider = new BearerToken(
      config.credentials,
      config.workspace,
      settings.baseUrl
    );
  } else if (config.credentials.client_credentials) {
    provider = new ClientCredentials(
      config.credentials,
      config.workspace,
      settings.baseUrl
    );
  } else {
    provider = new PublicAuth();
  }
  return provider;
}

/**
 * Creates a new client with the specified credentials.
 * @param config - The client configuration.
 * @returns A new client instance.
 */
export function newClientWithCredentials(config: RunClientWithCredentials) {
  const settings = getSettings();
  const provider = getProvider(config);

  return createClient(
    createConfig({
      baseUrl: settings.baseUrl,
      fetch: async (req: Request) => {
        const headers = await provider.getHeaders();
        Object.entries(headers).forEach(([key, value]) => {
          req.headers.set(key, value as string);
        });
        return fetch(req);
      },
    })
  );
}

/**
 * Retrieves the authentication headers for the current client configuration.
 * @returns A promise resolving to a record of header key-value pairs.
 */
export async function getAuthenticationHeaders(): Promise<
  Record<string, string>
> {
  const clientConfig = getClientConfig();
  const provider = getProvider(clientConfig);
  return await provider.getHeaders();
}
