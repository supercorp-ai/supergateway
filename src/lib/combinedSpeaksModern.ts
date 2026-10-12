import type {
  CombinedModernEntry,
  ModernMember,
  Request,
} from './combinedModernTypes.js'
import type { Logger } from '../types.js'
import { MODERN_VERSION, SPEAKS_FOR_MS } from './upstreamModernChild.js'
import { ask, detach } from './combinedModernAsk.js'
import { getVersion } from './getVersion.js'

const DISCOVER_TIMEOUT_MS = 10_000

const discoverRequest = (): Request => ({
  jsonrpc: '2.0',
  id: 'supergateway-discover',
  method: 'server/discover',
  params: {
    _meta: {
      'io.modelcontextprotocol/protocolVersion': MODERN_VERSION,
      'io.modelcontextprotocol/clientInfo': {
        name: 'supergateway',
        version: getVersion(),
      },
      'io.modelcontextprotocol/clientCapabilities': {},
    },
  },
})

/**
 * Whether every server of a combined entry speaks 2026-07-28, asked with
 * `server/discover` and remembered for a minute. One that does not makes
 * the entry answer the earlier versions only, as it did before: nothing is
 * translated between a client and a server that speak different ones.
 */
export function combinedSpeaksModern(
  entry: CombinedModernEntry,
  logger: Logger,
  now: () => number = Date.now,
) {
  let last: { at: number; speaks: Promise<boolean> } | undefined
  const speaksIt = async (member: ModernMember) => {
    if (!member.child) return false
    const child = member.child({ version: MODERN_VERSION, params: {} })
    try {
      await child.start()
      let timer!: NodeJS.Timeout
      const answer = await Promise.race([
        ask(child, discoverRequest()),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error('No answer')),
            DISCOVER_TIMEOUT_MS,
          )
        }),
      ]).finally(() => clearTimeout(timer))
      return answer.result!.supportedVersions.includes(MODERN_VERSION)
    } catch {
      return false
    } finally {
      detach(child)
      await child.close()
    }
  }
  return (): Promise<boolean> => {
    if (last && now() - last.at < SPEAKS_FOR_MS) return last.speaks
    const speaks = Promise.all(entry.members.map(speaksIt)).then((each) => {
      const all = each.every(Boolean)
      logger.info(
        all
          ? `${entry.name}: every server speaks ${MODERN_VERSION}`
          : `${entry.name}: ${entry.members
              .filter((_member, i) => !each[i])
              .map(({ name }) => `"${name}"`)
              .join(
                ', ',
              )} do not speak ${MODERN_VERSION}, so the entry answers the earlier versions`,
      )
      return all
    })
    last = { at: now(), speaks }
    return speaks
  }
}
