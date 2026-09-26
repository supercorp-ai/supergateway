/**
 * Newline-delimited messages from a child's stdout, as decoded text arrives.
 *
 * Every reader used to do `buffer += chunk; buffer.split(/\r?\n/)`, which
 * rescans everything held so far on every chunk. A line that arrives in many
 * chunks therefore cost time proportional to its length squared: a 50 MB reply
 * took 2.3s where 5 MB took 0.04s. Only the new text is searched for a newline
 * now, and a held line is joined once, when it completes.
 *
 * Lines end at `\n`, and a `\r` before it is dropped, which is what splitting
 * on `/\r?\n/` did.
 */
export class LineSplitter {
  private pending = ''

  /** The lines that `text` completes; an unfinished tail is held. */
  push(text: string): string[] {
    const end = text.lastIndexOf('\n')
    if (end === -1) {
      this.pending += text
      return []
    }
    const lines = (this.pending + text.slice(0, end)).split('\n')
    this.pending = text.slice(end + 1)
    return lines.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
  }
}
