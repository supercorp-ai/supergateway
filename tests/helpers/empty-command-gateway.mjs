// Exercise the public library entry points in their own process because they
// own signal handlers and (for WebSocket startup failure) process exit.
import { stdioToWs } from '../../dist/gateways/stdioToWs.js'
import { stdioToStatelessStreamableHttp } from '../../dist/gateways/stdioToStatelessStreamableHttp.js'

const args = {
  stdioCmd: '',
  port: Number(process.argv[3]),
  messagePath: '/ws',
  streamableHttpPath: '/mcp',
  logger: { info: console.log, error: console.error },
  corsOrigin: false,
  healthEndpoints: ['/health'],
  headers: {},
  protocolVersion: '2024-11-05',
}
if (process.argv[2] === 'ws') await stdioToWs(args)
else await stdioToStatelessStreamableHttp(args)
