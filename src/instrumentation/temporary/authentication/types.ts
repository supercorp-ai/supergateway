/**
 * Represents the overall configuration structure.
 */
export interface Config {
  context: ContextConfig;
  workspaces: WorkspaceConfig[];
}

/**
 * Represents the configuration of a workspace.
 */
export interface WorkspaceConfig {
  name: string;
  credentials: Credentials;
}

/**
 * Represents the context configuration, including workspace and environment.
 */
export interface ContextConfig {
  workspace: string;
  environment: string;
}

/**
 * Represents the various credentials used for authentication.
 */
export interface Credentials {
  apiKey?: string;
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  device_code?: string;
  client_credentials?: string;
}
