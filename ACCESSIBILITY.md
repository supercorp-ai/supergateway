# Accessibility

Supergateway is a command-line tool with no graphical interface, so accessibility here means its output, its documentation and how you can reach us. We want it to work well with screen readers, braille displays, voice control and any terminal setup, and we treat barriers as bugs.

## What works today

- **Plain text output.** Logs are plain lines of text, one event per line, with no spinners, progress bars or animations.
- **Machine-readable output.** `--logFormat json` writes one JSON object per line, so you can filter or re-render logs with any tool that suits you.
- **Less output.** `--logLevel none` silences logs, and `--logLevel debug` is opt-in.
- **Any environment.** It runs in any terminal on Linux, macOS and Windows, through npm, Docker or a standalone executable, and can be configured entirely from a JSON file (`--config`) instead of long command lines.
- **Text documentation.** The README and guides are Markdown with real headings, lists and code blocks, and no information that's only in images.

## Known limitations

- With `--logLevel debug` in a terminal, objects in log lines are printed with colour, and `NO_COLOR` doesn't turn it off yet. Redirect output to a file or use `--logFormat json` to get plain text.
- Messages and docs are in English only.

## Reporting a barrier

If something gets in your way, [open an issue](https://github.com/supercorp-ai/supergateway/issues/new?template=bug_report.yml) or tell us on [Discord](https://discord.gg/CudcAH53yF). Say what you were doing and what assistive technology or setup you use. Accessibility issues get the same priority as other bugs.
