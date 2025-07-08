/**
 * Safely stringify JSON by escaping Unicode line separators that can cause parsing issues.
 * This prevents issues with U+2028 (Line Separator) and U+2029 (Paragraph Separator)
 * characters that can break JSON parsing in some contexts.
 */
export function safeJsonStringify(value: any): string {
  return JSON.stringify(value)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

/**
 * Safely parse JSON by first escaping any unescaped Unicode line separators.
 * This handles cases where JSON contains raw U+2028 or U+2029 characters that
 * would otherwise cause parsing to fail.
 */
export function safeJsonParse(text: string): any {
  // First escape any unescaped Unicode line separators
  const escapedText = text
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
  return JSON.parse(escapedText)
}

/**
 * Sanitize JSON object by escaping Unicode line separators in string values.
 * This ensures the object can be safely stringified by standard JSON.stringify.
 */
export function sanitizeJsonObject(obj: any): any {
  if (typeof obj === 'string') {
    return obj.replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
  }
  if (Array.isArray(obj)) {
    return obj.map(sanitizeJsonObject)
  }
  if (obj !== null && typeof obj === 'object') {
    const sanitized: any = {}
    for (const [key, value] of Object.entries(obj)) {
      sanitized[sanitizeJsonObject(key)] = sanitizeJsonObject(value)
    }
    return sanitized
  }
  return obj
}

/**
 * JsonBuffer handles streaming JSON parsing for large responses and mixed content.
 * It can parse both line-based JSON (traditional) and large JSON objects without newlines.
 * Non-JSON content (like npm logs) is silently ignored.
 */
export class JsonBuffer {
  private buffer = ''
  private onMessage: (message: any) => void
  private onError: (error: string, rawData: string) => void

  constructor(
    onMessage: (message: any) => void,
    onError: (error: string, rawData: string) => void,
  ) {
    this.onMessage = onMessage
    this.onError = onError
  }

  addChunk(chunk: string) {
    this.buffer += chunk
    this.processBuffer()
  }

  private processBuffer() {
    while (this.buffer.length > 0) {
      // Try to extract complete JSON objects first (for large JSON without newlines)
      const jsonObject = this.extractJsonObject()
      if (jsonObject) {
        this.tryParseAndUpdate(jsonObject.json, jsonObject.remaining)
        continue
      }

      // Fall back to line-based processing
      const line = this.extractLine()
      if (!line) break

      this.tryParseAndUpdate(line.content, line.remaining)
    }
  }

  private extractJsonObject(): { json: string; remaining: string } | null {
    const start = this.buffer.indexOf('{')
    if (start === -1) return null

    let braceCount = 0
    let inString = false
    let escaped = false

    for (let i = start; i < this.buffer.length; i++) {
      const char = this.buffer[i]

      if (escaped) {
        escaped = false
        continue
      }

      if (char === '\\' && inString) {
        escaped = true
        continue
      }

      if (char === '"') {
        inString = !inString
        continue
      }

      if (!inString) {
        if (char === '{') braceCount++
        else if (char === '}') {
          braceCount--
          if (braceCount === 0) {
            return {
              json: this.buffer.slice(start, i + 1),
              remaining: this.buffer.slice(i + 1),
            }
          }
        }
      }
    }
    return null
  }

  private extractLine(): { content: string; remaining: string } | null {
    const newlineIndex = this.buffer.search(/\r?\n/)
    if (newlineIndex === -1) return null

    return {
      content: this.buffer.slice(0, newlineIndex).trim(),
      remaining: this.buffer.slice(newlineIndex + 1),
    }
  }

  private tryParseAndUpdate(content: string, remaining: string) {
    if (!content) {
      this.buffer = remaining
      return
    }

    // Only try to parse JSON-like content
    if (content.startsWith('{') || content.includes('"jsonrpc"')) {
      try {
        const parsed = safeJsonParse(content)
        this.onMessage(parsed)
      } catch (error) {
        this.onError(`Failed to parse JSON: ${error}`, content.slice(0, 200))
      }
    }
    // Non-JSON content is silently ignored

    this.buffer = remaining
  }

  flush() {
    if (this.buffer.trim()) {
      this.tryParseAndUpdate(this.buffer.trim(), '')
    }
  }
}
