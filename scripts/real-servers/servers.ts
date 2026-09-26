import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'

/**
 * Real MCP servers, pinned to exact versions, each with a script of calls whose
 * answers do not depend on time, randomness or the environment. The soak runs
 * every script directly over stdio and through every gateway path, and the
 * answers must be identical.
 *
 * Bump a version deliberately: a server's own behaviour changes with it, and
 * the point is to see the gateway's.
 */
export interface RealServer {
  name: string
  /** Program and arguments, exactly as a user would put them in --stdio. */
  argv: string[]
  /** Extra environment. `run` is a fresh directory for each connection path. */
  env?: (run: string) => Record<string, string>
  /** Calls to make, in order; each result is compared across paths. */
  steps: Array<[label: string, call: (client: Client) => Promise<unknown>]>
  /**
   * Masks what differs between two direct runs, applied to the JSON of
   * everything observed. Keep it narrow: whatever it masks, the soak cannot see.
   */
  normalize?: (json: string) => string
}

const tool = (name: string, args: Record<string, unknown> = {}) =>
  [
    `tools/call ${name}`,
    (client: Client) => client.callTool({ name, arguments: args }),
  ] as [string, (client: Client) => Promise<unknown>]

/** Shared read-only fixtures, created once per soak lane. */
export function prepareFixtures(root: string) {
  const files = join(root, 'files')
  mkdirSync(join(files, 'sub'), { recursive: true })
  writeFileSync(join(files, 'a.txt'), 'alpha\nsecond line\n')
  writeFileSync(join(files, 'sub', 'b.md'), '# beta\n\nA heading and a line.\n')
  writeFileSync(join(files, 'sub', 'c.json'), '{"gamma": [1, 2, 3]}\n')

  // Fixed identities and dates, so commit hashes are the same on every lane.
  const repo = join(root, 'repo')
  mkdirSync(repo, { recursive: true })
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: repo,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Soak',
        GIT_AUTHOR_EMAIL: 'soak@example.com',
        GIT_COMMITTER_NAME: 'Soak',
        GIT_COMMITTER_EMAIL: 'soak@example.com',
        GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
        GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
      },
    })
  git('init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'README.md'), 'first\n')
  git('add', 'README.md')
  git('commit', '-q', '-m', 'first commit')
  writeFileSync(join(repo, 'README.md'), 'first\nsecond\n')
  git('commit', '-q', '-am', 'second commit')
  // An unstaged change, so status and diff have something to report.
  writeFileSync(join(repo, 'README.md'), 'first\nsecond\nthird\n')
  return { files, repo }
}

export function realServers(fixtures: { files: string; repo: string }) {
  const servers: RealServer[] = [
    {
      name: 'server-everything',
      argv: ['npx', '-y', '@modelcontextprotocol/server-everything@2026.8.31'],
      // Dynamic resources say when they were created.
      normalize: (json) =>
        json.replace(
          /created at \d{1,2}:\d{2}:\d{2} [AP]M/g,
          'created at <time>',
        ),
      steps: [
        tool('echo', { message: 'héllo – 🙂   end' }),
        tool('get-sum', { a: 19, b: 23 }),
        tool('get-tiny-image'),
        tool('get-annotated-message', { messageType: 'error' }),
        tool('get-annotated-message', { messageType: 'success' }),
        tool('get-resource-reference', { resourceType: 'Text', resourceId: 3 }),
        tool('get-resource-links', { count: 5 }),
        tool('get-structured-content', { location: 'Chicago' }),
        [
          'prompts/get simple-prompt',
          (c) => c.getPrompt({ name: 'simple-prompt' }),
        ],
        [
          'prompts/get args-prompt',
          (c) =>
            c.getPrompt({
              name: 'args-prompt',
              arguments: { city: 'Vilnius', state: 'LT' },
            }),
        ],
        [
          'completion/complete',
          (c) =>
            c.complete({
              ref: { type: 'ref/prompt', name: 'completable-prompt' },
              argument: { name: 'department', value: 'E' },
            }),
        ],
        [
          'resources/read static',
          (c) =>
            c.readResource({
              uri: 'demo://resource/static/document/architecture.md',
            }),
        ],
        [
          'resources/read template',
          (c) => c.readResource({ uri: 'demo://resource/dynamic/text/2' }),
        ],
      ],
    },
    {
      name: 'server-memory',
      argv: ['npx', '-y', '@modelcontextprotocol/server-memory@2026.8.31'],
      // Each path starts from an empty graph of its own.
      env: (run) => ({ MEMORY_FILE_PATH: join(run, 'memory.jsonl') }),
      steps: [
        tool('create_entities', {
          entities: [
            {
              name: 'Ada',
              entityType: 'person',
              observations: ['wrote the notes'],
            },
            { name: 'Engine', entityType: 'machine', observations: [] },
          ],
        }),
        tool('create_relations', {
          relations: [{ from: 'Ada', to: 'Engine', relationType: 'designed' }],
        }),
        tool('add_observations', {
          observations: [{ entityName: 'Engine', contents: ['analytical'] }],
        }),
        tool('search_nodes', { query: 'Ada' }),
        tool('open_nodes', { names: ['Engine'] }),
        tool('read_graph'),
      ],
    },
    {
      name: 'server-filesystem',
      argv: [
        'npx',
        '-y',
        '@modelcontextprotocol/server-filesystem@2026.8.31',
        fixtures.files,
      ],
      steps: [
        tool('list_allowed_directories'),
        tool('list_directory', { path: fixtures.files }),
        tool('directory_tree', { path: fixtures.files }),
        tool('read_text_file', { path: join(fixtures.files, 'a.txt') }),
        tool('read_text_file', {
          path: join(fixtures.files, 'a.txt'),
          head: 1,
        }),
        tool('read_multiple_files', {
          paths: [
            join(fixtures.files, 'sub', 'b.md'),
            join(fixtures.files, 'sub', 'c.json'),
          ],
        }),
        tool('search_files', { path: fixtures.files, pattern: '**/*.md' }),
        // Refused outside the allowed directory: errors must cross unchanged.
        tool('read_text_file', { path: '/etc/hosts' }),
      ],
    },
    {
      name: 'server-sequential-thinking',
      argv: [
        'npx',
        '-y',
        '@modelcontextprotocol/server-sequential-thinking@2026.8.31',
      ],
      env: () => ({ DISABLE_THOUGHT_LOGGING: 'true' }),
      steps: [
        tool('sequentialthinking', {
          thought: 'One step is enough.',
          nextThoughtNeeded: false,
          thoughtNumber: 1,
          totalThoughts: 1,
        }),
      ],
    },
    {
      name: 'mcp-server-time (Python)',
      argv: ['uvx', 'mcp-server-time@2026.8.18', '--local-timezone', 'UTC'],
      steps: [
        tool('convert_time', {
          source_timezone: 'UTC',
          time: '12:00',
          target_timezone: 'Asia/Tokyo',
        }),
        // An invalid zone: the server's error must cross unchanged.
        tool('convert_time', {
          source_timezone: 'Nowhere/Nothing',
          time: '12:00',
          target_timezone: 'UTC',
        }),
      ],
    },
    {
      name: 'mcp-server-git (Python)',
      argv: ['uvx', 'mcp-server-git@2026.8.18'],
      // git_show prints a Python object's repr, memory address included.
      normalize: (json) => json.replace(/ at 0x[0-9a-f]+>/g, ' at <address>>'),
      steps: [
        tool('git_status', { repo_path: fixtures.repo }),
        tool('git_log', { repo_path: fixtures.repo, max_count: 5 }),
        tool('git_show', { repo_path: fixtures.repo, revision: 'HEAD' }),
        tool('git_diff_unstaged', { repo_path: fixtures.repo }),
        tool('git_branch', { repo_path: fixtures.repo, branch_type: 'local' }),
      ],
    },
  ]
  return servers
}
