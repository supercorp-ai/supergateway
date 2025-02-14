import * as fs from "fs";
import * as path from "path";
import * as yaml from "yaml";
import { z } from "zod";
import { currentContext } from "../authentication/credentials.js";

declare global {
  var SETTINGS: Settings | null; // eslint-disable-line
}
global.SETTINGS = null;

/**
 * Schema for agent settings.
 */
const SettingsAgent = z.object({
  agent: z.any().nullable().default(null),
  chain: z.array(z.any()).nullable().default(null),
  model: z.any().nullable().default(null),
  functions: z.array(z.any()).nullable().default(null),
  functionsDirectory: z.string().default("src/functions"),
  chatModel: z.any().nullable().default(null),
  module: z.string().default("main.main"),
});
type SettingsAgentType = z.infer<typeof SettingsAgent>;

/**
 * Schema for authentication settings.
 */
const SettingsAuthentication = z.object({
  apiKey: z.string().nullable().default(null),
  jwt: z.string().nullable().default(null),
  clientCredentials: z.string().nullable().default(null),
});
type SettingsAuthenticationType = z.infer<typeof SettingsAuthentication>;

/**
 * Schema for server settings.
 */
const SettingsServer = z.object({
  module: z.string().default("agent.agent"),
  port: z.number().default(80),
  host: z.string().default("0.0.0.0"),
  directory: z.string().default("src"),
});
type SettingsServerType = z.infer<typeof SettingsServer>;

/**
 * Schema for overall settings.
 */
const Settings = z.object({
  workspace: z.string(),
  environment: z.string().default("production"),
  remote: z.boolean().default(false),
  type: z.string().default("agent"),
  name: z.string().default("beamlit-agent"),
  baseUrl: z
    .string()
    .regex(/^https?:\/\/[^\s/$.?#].[^\s]*$/, "Invalid URL format")
    .default("https://api.beamlit.com/v0"),
  appUrl: z
    .string()
    .regex(/^https?:\/\/[^\s/$.?#].[^\s]*$/, "Invalid URL format")
    .default("https://app.beamlit.com"),
  runUrl: z
    .string()
    .regex(/^https?:\/\/[^\s/$.?#].[^\s]*$/, "Invalid URL format")
    .default("https://run.beamlit.com"),
  registryUrl: z
    .string()
    .regex(/^https?:\/\/[^\s/$.?#].[^\s]*$/, "Invalid URL format")
    .default("https://us.registry.beamlit.com"),
  logLevel: z.string().default("INFO"),
  enableOpentelemetry: z.boolean().default(false),
  agent: SettingsAgent.default({ chain: null, functions: null }),
  server: SettingsServer.default({}),
  authentication: SettingsAuthentication.default({
    apiKey: null,
    jwt: null,
    clientCredentials: null,
  }),
  deploy: z.boolean().default(false),
});
type Settings = z.infer<typeof Settings>;

/**
 * Retrieves the current settings, initializing if not already done.
 * @returns The current settings object.
 */
function getSettings(): Settings {
  if (!global.SETTINGS) {
    global.SETTINGS = init();
  }
  return global.SETTINGS;
}

/**
 * Parses an environment variable value to its appropriate type.
 * @param value - The environment variable value as a string.
 * @returns The parsed value as boolean, number, or string.
 */
function parseEnv(value: string) {
  if (value.toLowerCase() === "true") {
    return true as any;
  } else if (value.toLowerCase() === "false") {
    return false as any;
  } else {
    const numberValue = Number(value);
    if (!isNaN(numberValue)) {
      return numberValue;
    }
    return value;
  }
}

/**
 * Handles nested environment variable settings.
 * @param envData - The current environment data object.
 * @param settingKey - The key of the setting.
 * @param value - The value of the environment variable.
 * @param nestedKey - The nested key within the settings.
 * @returns The updated nested environment data.
 */
function handleNestedEnvironment(
  envData: Partial<Settings>,
  settingKey: string,
  value: string,
  nestedKey: keyof Settings
) {
  const key = (settingKey
    .replace(nestedKey, "")
    .split("_")
    .join("")
    .charAt(0)
    .toLowerCase() +
    settingKey.replace(nestedKey, "").split("_").join("").slice(1)) as
    | keyof SettingsAuthenticationType
    | keyof SettingsAgentType
    | keyof SettingsServerType;
  if (!envData[nestedKey]) {
    envData[nestedKey] = {} as any;
  }
  if (envData[nestedKey] && key) {
    (envData[nestedKey] as any)[key] = parseEnv(value);
  }
  return envData[nestedKey];
}

/**
 * Initializes the settings by merging configurations from YAML, environment variables, and options.
 * @param options - Optional settings to override defaults.
 * @returns The initialized settings object.
 */
function init(options: Partial<Settings> = {}): Settings {
  // Try to read beamlit.yaml from current directory
  let yamlData: Partial<Settings> = {};
  try {
    const yamlFile = fs.readFileSync(
      path.join(process.cwd(), "beamlit.yaml"),
      "utf8"
    );
    yamlData = yaml.parse(yamlFile);
  } catch {
    // Do nothing it is not a problem
  }

  // Process environment variables
  const envData: Partial<Settings> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("BL_") && value !== undefined) {
      const settingKey = key
        .slice(3) // Remove BL_ prefix
        .toLowerCase()
        .split("_")
        .map((part, index) =>
          index === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)
        )
        .join("") as keyof Settings;

      if (settingKey.startsWith("authentication")) {
        envData.authentication = handleNestedEnvironment(
          envData,
          settingKey,
          value,
          "authentication"
        ) as SettingsAuthenticationType;
      } else if (settingKey.startsWith("agent")) {
        envData.agent = handleNestedEnvironment(
          envData,
          settingKey,
          value,
          "agent"
        ) as SettingsAgentType;
      } else if (settingKey.startsWith("server")) {
        envData.server = handleNestedEnvironment(
          envData,
          settingKey,
          value,
          "server"
        ) as SettingsServerType;
      } else {
        envData[settingKey] = parseEnv(value);
      }
    }
  }

  // Special handling for dev environment
  if (process.env.BL_ENV === "dev") {
    envData.baseUrl = process.env.BL_BASE_URL || "https://api.beamlit.dev/v0";
    envData.runUrl = process.env.BL_RUN_URL || "https://run.beamlit.dev";
    envData.registryUrl =
      process.env.BL_REGISTRY_URL || "https://eu.registry.beamlit.dev";
    envData.appUrl = process.env.BL_APP_URL || "https://app.beamlit.dev";
  }
  const context = currentContext();

  // Merge configurations with precedence: options > env > yaml
  global.SETTINGS = Settings.parse({
    workspace: context.workspace,
    ...yamlData,
    ...envData,
    ...options,
    authentication: {
      ...yamlData.authentication,
      ...envData.authentication,
      ...options.authentication,
    },
    server: {
      ...yamlData.server,
      ...envData.server,
      ...options.server,
    },
    agent: {
      ...yamlData.agent,
      ...envData.agent,
      ...options.agent,
    },
  });

  return global.SETTINGS;
}

export {
  getSettings,
  init,
  Settings,
  SettingsAgent,
  SettingsAuthentication,
  SettingsServer,
  type SettingsAgentType,
  type SettingsAuthenticationType,
  type SettingsServerType,
  type Settings as SettingsType,
};
