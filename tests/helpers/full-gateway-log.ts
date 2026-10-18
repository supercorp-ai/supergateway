import { appendFileSync, mkdirSync } from 'node:fs'

/**
 * A soak gateway's whole log, when SOAK_GATEWAY_LOG_DIR is set (the soak
 * workflow sets it): one file per gateway, every line timestamped and cut to
 * 300 characters, as replies of up to 4 MB are logged in full. The soak itself
 * keeps only the last 64 KB, which by the time a check fails no longer reaches
 * what led to it: 4.2.1-rc.1's first soak lost two Windows incidents that way.
 */
export function fullGatewayLog(pid: number, label: string, chunk: string) {
  const dir = process.env.SOAK_GATEWAY_LOG_DIR
  if (!dir) return
  mkdirSync(dir, { recursive: true })
  const now = new Date().toISOString().slice(11, 23)
  appendFileSync(
    `${dir}/${pid}-${label.replace(/[^\w-]+/g, '_').slice(0, 60)}.log`,
    chunk
      .split('\n')
      .filter((line) => line)
      .map((line) => `${now} ${line.slice(0, 300)}\n`)
      .join(''),
  )
}
