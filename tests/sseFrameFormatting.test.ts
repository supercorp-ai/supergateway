import { describe, it, expect } from 'vitest';

/**
 * Isolated unit tests for Server-Sent Events (SSE) data frame string formatting.
 */

function formatSseEvent(eventName: string, data: unknown): string {
  const serialized = typeof data === 'string' ? data : JSON.stringify(data);
  return `event: ${eventName.trim()}\ndata: ${serialized}\n\n`;
}

describe('SSE Event Frame Formatter', () => {
  it('should format event name and JSON string payload', () => {
    const frame = formatSseEvent('token', { text: 'Hello' });
    expect(frame).toBe('event: token\ndata: {"text":"Hello"}\n\n');
  });

  it('should handle raw string payload without double-encoding', () => {
    const frame = formatSseEvent('ping', '[DONE]');
    expect(frame).toBe('event: ping\ndata: [DONE]\n\n');
  });

  it('should trim surrounding whitespace from event names', () => {
    const frame = formatSseEvent('  completion  ', { id: 1 });
    expect(frame).toBe('event: completion\ndata: {"id":1}\n\n');
  });
});
