export interface Logger {
  info: (...args: any[]) => void
  error: (...args: any[]) => void
}
