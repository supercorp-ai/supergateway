export interface Logger {
  info: (...args: any[]) => void
  error: (...args: any[]) => void
}

export interface MultiStdioServerConfig {
  path: string
  stdioCmd: string
}
