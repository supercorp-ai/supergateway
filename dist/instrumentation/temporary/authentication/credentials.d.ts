import { Settings } from "../common/settings.js";
import { ContextConfig, Credentials } from "./types.js";
/**
 * Lists all workspace names in the current context.
 * @returns An array of workspace names.
 */
export declare function listContextWorkspaces(): string[];
/**
 * Retrieves the current context configuration.
 * @returns The current context configuration.
 */
export declare function currentContext(): ContextConfig;
/**
 * Sets the current workspace and environment in the context.
 * @param workspaceName - The name of the workspace to set.
 * @param environment - The environment to set.
 */
export declare function setCurrentWorkspace(workspaceName: string, environment: string): void;
/**
 * Loads the credentials for a specified workspace.
 * @param workspaceName - The name of the workspace.
 * @returns The credentials associated with the workspace.
 */
export declare function loadCredentials(workspaceName: string): Credentials;
/**
 * Loads the credentials from the application settings.
 * @param settings - The application settings.
 * @returns The loaded credentials.
 */
export declare function loadCredentialsFromSettings(settings: Settings): Credentials;
/**
 * Ensures the home directory exists, creating it if necessary.
 */
export declare function createHomeDirIfMissing(): void;
/**
 * Saves the provided credentials for a specified workspace.
 * @param workspaceName - The name of the workspace.
 * @param credentials - The credentials to save.
 */
export declare function saveCredentials(workspaceName: string, credentials: Credentials): void;
/**
 * Clears the credentials for a specified workspace.
 * @param workspaceName - The name of the workspace.
 */
export declare function clearCredentials(workspaceName: string): void;
