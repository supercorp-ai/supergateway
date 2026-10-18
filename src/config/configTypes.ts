import type { HealthCheck } from '../lib/serverHealth.js'

/** What a `--config` file is once read: see configFile.ts for the rules. */

export type Transport = 'stdio' | 'sse' | 'ws' | 'streamableHttp'

/** Settings for the URL an entry is served at; any of them may be top-level. */
export interface EndpointOptions {
  outputTransport?: Transport
  baseUrl?: string
  ssePath?: string
  messagePath?: string
  streamableHttpPath?: string
  cors?: boolean | string[]
  healthEndpoint?: string[]
  healthCheck?: HealthCheck
  toolPrefix?: string
  tools?: string[]
  headers?: Record<string, string>
  oauth2Bearer?: string
  apiKey?: string[]
  apiKeyFile?: string
  stateful?: boolean
  sessionTimeout?: number
  protocolVersion?: string
}

/** What to run, or where to connect. */
export type ServerSource =
  | { kind: 'command'; command: string; args: string[] }
  | { kind: 'stdio'; stdio: string }
  | { kind: 'url'; url: string; type: 'sse' | 'streamableHttp' }

export interface InnerServer {
  name: string
  source: ServerSource
  env?: Record<string, string>
  cwd?: string
  headers?: Record<string, string>
  oauth2Bearer?: string
  /** A combined server's own tool settings; an entry's are its options. */
  toolPrefix?: string
  tools?: string[]
}

export interface Entry extends EndpointOptions {
  name: string
  /** Where it is served; `/<name>` unless the file sets `path`. */
  path: string
  /** One server, or the servers combined on this entry's URL. */
  server: Omit<InnerServer, 'name'> | { members: InnerServer[] }
}

export interface GatewaySettings {
  port?: number
  host?: string
  logLevel?: 'debug' | 'info' | 'none'
  logFormat?: 'text' | 'json'
  exitWithProcess?: number
  /** The gateway's own health endpoints, as `--healthEndpoint`. */
  healthEndpoint?: string[]
}

export interface Config {
  gateway: GatewaySettings
  defaults: EndpointOptions
  entries: Entry[]
}

export type Loaded =
  { config: Config; warnings: string[] } | { error: string; warnings: string[] }

export type Fail = (path: (string | number)[], message: string) => never
