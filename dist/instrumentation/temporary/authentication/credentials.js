import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import * as yaml from "js-yaml";
import { homedir } from "os";
import { join } from "path";
import { logger } from "../../../logger/index.js";
/**
 * Loads the application configuration from the user's home directory.
 * @returns The loaded configuration object.
 */
function loadConfig() {
    const config = {
        workspaces: [],
        context: {
            workspace: "",
            environment: "",
        },
    };
    const homeDir = homedir();
    if (homeDir) {
        const configPath = join(homeDir, ".blaxel", "config.yaml");
        if (existsSync(configPath)) {
            try {
                const data = yaml.load(readFileSync(configPath, "utf8"));
                if (data) {
                    const workspaces = [];
                    for (const ws of data.workspaces || []) {
                        const creds = {
                            apiKey: ws.credentials?.apiKey || "",
                            access_token: ws.credentials?.access_token || "",
                            refresh_token: ws.credentials?.refresh_token || "",
                            expires_in: ws.credentials?.expires_in || 0,
                            device_code: ws.credentials?.device_code || "",
                            client_credentials: ws.credentials?.client_credentials || "",
                        };
                        workspaces.push({ name: ws.name, credentials: creds });
                    }
                    config.workspaces = workspaces;
                    if (data.context) {
                        config.context = data.context;
                    }
                }
            }
            catch {
                // Invalid YAML, use empty config
            }
        }
    }
    return config;
}
/**
 * Saves the application configuration to the user's home directory.
 * @param config - The configuration to save.
 */
function saveConfig(config) {
    const homeDir = homedir();
    if (!homeDir) {
        throw new Error("Could not determine home directory");
    }
    const configDir = join(homeDir, ".blaxel");
    const configFile = join(configDir, "config.yaml");
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    writeFileSync(configFile, yaml.dump({
        workspaces: config.workspaces.map((ws) => ({
            name: ws.name,
            credentials: {
                apiKey: ws.credentials.apiKey,
                access_token: ws.credentials.access_token,
                refresh_token: ws.credentials.refresh_token,
                expires_in: ws.credentials.expires_in,
                device_code: ws.credentials.device_code,
            },
        })),
        context: config.context,
    }));
}
/**
 * Lists all workspace names in the current context.
 * @returns An array of workspace names.
 */
export function listContextWorkspaces() {
    const config = loadConfig();
    return config.workspaces.map((workspace) => workspace.name);
}
/**
 * Retrieves the current context configuration.
 * @returns The current context configuration.
 */
export function currentContext() {
    const config = loadConfig();
    return config.context;
}
/**
 * Sets the current workspace and environment in the context.
 * @param workspaceName - The name of the workspace to set.
 * @param environment - The environment to set.
 */
export function setCurrentWorkspace(workspaceName, environment) {
    const config = loadConfig();
    config.context.workspace = workspaceName;
    config.context.environment = environment;
    saveConfig(config);
}
/**
 * Loads the credentials for a specified workspace.
 * @param workspaceName - The name of the workspace.
 * @returns The credentials associated with the workspace.
 */
export function loadCredentials(workspaceName) {
    const config = loadConfig();
    const workspace = config.workspaces.find((ws) => ws.name === workspaceName);
    if (workspace) {
        return workspace.credentials;
    }
    return {
        apiKey: "",
        access_token: "",
        refresh_token: "",
        expires_in: 0,
        device_code: "",
        client_credentials: "",
    };
}
/**
 * Loads the credentials from the application settings.
 * @param settings - The application settings.
 * @returns The loaded credentials.
 */
export function loadCredentialsFromSettings(settings) {
    return {
        apiKey: settings.authentication?.apiKey || "",
        access_token: settings.authentication?.jwt || "",
        client_credentials: settings.authentication?.clientCredentials || "",
    };
}
/**
 * Ensures the home directory exists, creating it if necessary.
 */
export function createHomeDirIfMissing() {
    const homeDir = homedir();
    if (!homeDir) {
        logger.error("Error getting home directory");
        return;
    }
    const credentialsDir = join(homeDir, ".blaxel");
    const credentialsFile = join(credentialsDir, "credentials.json");
    if (existsSync(credentialsFile)) {
        logger.warn("You are already logged in. Enter a new API key to overwrite it.");
    }
    else {
        try {
            mkdirSync(credentialsDir, { recursive: true, mode: 0o700 });
        }
        catch (e) {
            logger.error(`Error creating credentials directory: ${e}`);
        }
    }
}
/**
 * Saves the provided credentials for a specified workspace.
 * @param workspaceName - The name of the workspace.
 * @param credentials - The credentials to save.
 */
export function saveCredentials(workspaceName, credentials) {
    createHomeDirIfMissing();
    if (!credentials.access_token && !credentials.apiKey) {
        logger.info("No credentials to save, error");
        return;
    }
    const config = loadConfig();
    let found = false;
    for (let i = 0; i < config.workspaces.length; i++) {
        if (config.workspaces[i].name === workspaceName) {
            config.workspaces[i].credentials = credentials;
            found = true;
            break;
        }
    }
    if (!found) {
        config.workspaces.push({ name: workspaceName, credentials });
    }
    saveConfig(config);
}
/**
 * Clears the credentials for a specified workspace.
 * @param workspaceName - The name of the workspace.
 */
export function clearCredentials(workspaceName) {
    const config = loadConfig();
    config.workspaces = config.workspaces.filter((ws) => ws.name !== workspaceName);
    if (config.context.workspace === workspaceName) {
        config.context.workspace = "";
    }
    saveConfig(config);
}
