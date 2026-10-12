import type { Fail } from './configTypes.js'
import { printParseErrorCode } from 'jsonc-parser'

export function object(value: unknown, path: (string | number)[], fail: Fail) {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    fail(path, 'Expected an object')
  return value as Record<string, unknown>
}

export function text(
  value: unknown,
  path: (string | number)[],
  fail: Fail,
): string {
  if (typeof value !== 'string' || value.trim() === '')
    fail(path, 'Expected a non-empty string')
  return value as string
}

export function urlText(value: unknown, path: (string | number)[], fail: Fail) {
  const raw = text(value, path, fail)
  try {
    const url = new URL(raw)
    if (url.protocol === 'http:' || url.protocol === 'https:') return raw
  } catch {
    // Reported below.
  }
  return fail(path, `"${raw}" is not an http(s) URL`)
}

export function boolean(value: unknown, path: (string | number)[], fail: Fail) {
  if (typeof value !== 'boolean') fail(path, 'Expected true or false')
  return value as boolean
}

export function integer(
  value: unknown,
  path: (string | number)[],
  fail: Fail,
  min: number,
) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min)
    fail(path, `Expected a whole number of at least ${min}`)
  return value as number
}

export function oneOf(
  value: unknown,
  path: (string | number)[],
  choices: readonly string[],
  fail: Fail,
) {
  if (typeof value !== 'string' || !choices.includes(value))
    fail(path, `Expected one of ${choices.map((c) => `"${c}"`).join(', ')}`)
  return value as string
}

// `emptyAllowed` is for command arguments, where "" is a real argument.
export function strings(
  value: unknown,
  path: (string | number)[],
  fail: Fail,
  expected = 'a list of strings',
  emptyAllowed = false,
) {
  if (
    !Array.isArray(value) ||
    value.some(
      (item) =>
        typeof item !== 'string' || (!emptyAllowed && item.trim() === ''),
    )
  )
    fail(path, `Expected ${expected}`)
  return value as string[]
}

export function stringMap(
  value: unknown,
  path: (string | number)[],
  fail: Fail,
) {
  const raw = object(value, path, fail)
  for (const [key, item] of Object.entries(raw))
    if (typeof item !== 'string')
      fail([...path, key], 'Expected a string value')
  return raw as Record<string, string>
}

export function describeParseError(code: number) {
  const name = printParseErrorCode(code)
  return name.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()
}

export const pathText = (path: (string | number)[]) =>
  path
    .map((part, i) => {
      if (typeof part === 'number') return `[${part}]`
      const key = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(part) ? part : `"${part}"`
      return i === 0 ? key : `.${key}`
    })
    .join('')

export const entryText = (name: string) => pathText(['mcpServers', name])
