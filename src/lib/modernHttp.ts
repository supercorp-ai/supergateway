import type { ToolNames } from './toolNames.js'
import type { OwnedChildProcesses } from './ownedChildProcesses.js'
import type { Logger } from '../types.js'
import type { ChildCommand } from './childCommand.js'
import type { RemoteServer } from './upstreamPeer.js'
import {
  type CombinedModernEntry,
  combinedSpeaksModern,
  CombinedModernChild,
  type ModernMember,
} from './combinedModernChild.js'
import {
  remoteSpeaksModern,
  type ModernChild,
  UpstreamModernChild,
} from './upstreamModernChild.js'
import type { Request, Response } from 'express'
import { OwnedStdioTransport } from './ownedStdioTransport.js'
import {
  headerValue,
  paramHeaders,
  admit,
  rejectWith,
} from './modernAdmission.js'
import {
  RetainedChildren,
  CONTINUATION_TIMEOUT,
  RETAINED_CHILD_LIMIT,
  isContinuationHandle,
} from './retainedChildren.js'
import { PerRequestHTTPServerTransport } from './modernSdk.js'
import { type Reused, ModernRequest } from './modernRequest.js'
import type { ServerSource } from './serverSource.js'

export function createModernHttp(
  args: {
    /** The tools a client sees of the server, if not all as they are. */
    toolNames?: ToolNames
    children: OwnedChildProcesses
    logger: Logger
  } & (
    | { stdioCmd: ChildCommand; upstream?: undefined; combined?: undefined }
    | { upstream: RemoteServer; stdioCmd?: undefined; combined?: undefined }
    | {
        combined: CombinedModernEntry
        stdioCmd?: undefined
        upstream?: undefined
      }
  ),
) {
  const { toolNames, children, logger } = args
  // A local server is sent whatever its client sends. A remote one, or
  // several combined, are asked first whether they speak the version at all.
  const speaks = args.combined
    ? combinedSpeaksModern(args.combined, logger)
    : args.upstream
      ? remoteSpeaksModern(args.upstream, logger)
      : () => true
  // The server one request is for: a process started for it, the remote
  // server, or the servers combined, told what the client's request declared.
  const childFor = (req: Request): ModernChild => {
    if (args.stdioCmd !== undefined)
      return new OwnedStdioTransport(args.stdioCmd, children, logger)
    const declared = {
      version: headerValue(req)('mcp-protocol-version'),
      params: paramHeaders(req),
    }
    return args.combined
      ? new CombinedModernChild(args.combined, declared, logger)
      : new UpstreamModernChild(args.upstream!, declared, logger)
  }
  const active = new Set<() => Promise<void>>()
  const retained = new RetainedChildren({
    idleMs: CONTINUATION_TIMEOUT,
    limit: RETAINED_CHILD_LIMIT,
    logger,
  })
  return {
    async close() {
      const closing = retained.close()
      await Promise.all([...active].map((stop) => stop()))
      await closing
    },
    async handle(req: Request, res: Response): Promise<boolean> {
      const value = headerValue(req)
      const route = await admit(req, res, value, speaks)
      if (typeof route === 'boolean') return route
      const transport = new PerRequestHTTPServerTransport({
        classification: route.classification,
      })
      const continuation =
        route.messageKind === 'request'
          ? route.message.params!.requestState
          : undefined
      let reused: Reused
      if (isContinuationHandle(continuation)) {
        const client = whileConnected(res)
        reused = await retained.take(continuation, client.signal)
        client.done()
        if (!reused) {
          await transport.close()
          if (!res.destroyed)
            rejectWith(req, res, 400, {
              code: INVALID_PARAMS,
              message: 'Continuation expired or backend unavailable',
            })
          return true
        }
      }
      return new ModernRequest({
        req,
        res,
        route,
        value,
        transport,
        reused,
        child: reused?.child ?? childFor(req),
        retained,
        active,
        children,
        toolNames,
        logger,
      }).serve()
    },
  }
}

/**
 * The 2026-07-28 relay for a gateway's server, if it can have one: a local
 * server is started for each request, a remote Streamable HTTP server is
 * sent each, and servers combined are sent what is theirs. A remote SSE
 * server has no such requests; a client asking it for 2026-07-28 is told it
 * is not spoken, and falls back by itself.
 */
export function modernRelayFor(
  source: ServerSource,
  children: OwnedChildProcesses,
  logger: Logger,
) {
  const { toolNames } = source
  const common = { toolNames, children, logger }
  // "Given", not "non-empty": the library entry points take an empty
  // command, which fails when it is started, as it always has.
  if (source.stdioCmd !== undefined)
    return createModernHttp({ stdioCmd: source.stdioCmd, ...common })
  if (source.combined)
    return createModernHttp({
      combined: {
        name: source.combined.name,
        members: source.combined.members.map((member) =>
          modernMember(member, children, logger),
        ),
        tables: new Map(),
        warned: source.combined.warned,
      },
      ...common,
    })
  // Neither a command nor several servers: a remote one.
  const upstream = source.upstream!
  return upstream.type === 'streamableHttp'
    ? createModernHttp({ upstream, ...common })
    : undefined
}

// One of the servers combined, as a 2026-07-28 request reaches it.
const modernMember = (
  member: ServerSource & { name: string },
  children: OwnedChildProcesses,
  logger: Logger,
): ModernMember => {
  const { name, toolNames, stdioCmd, upstream } = member
  if (stdioCmd !== undefined)
    return {
      name,
      toolNames,
      child: () => new OwnedStdioTransport(stdioCmd, children, logger),
    }
  // The loader combines servers one level deep, so it is a remote one.
  return upstream!.type === 'streamableHttp'
    ? {
        name,
        toolNames,
        child: (request) => new UpstreamModernChild(upstream!, request, logger),
      }
    : { name, toolNames }
}

// A signal that aborts if the client goes away, until `done`.
const whileConnected = (res: Response) => {
  const waiting = new AbortController()
  const cancelled = () => waiting.abort()
  res.once('close', cancelled)
  if (res.destroyed) waiting.abort()
  return {
    signal: waiting.signal,
    done: () => res.off('close', cancelled),
  }
}
const INVALID_PARAMS = -32602
