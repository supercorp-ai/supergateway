import tsparser from '@typescript-eslint/parser'
import tseslint from '@typescript-eslint/eslint-plugin'

// Deliberately narrow. These rules are here because each one corresponds to a
// class of defect this gateway has actually shipped, not because they are
// generally recommended:
//
//   no-floating-promises  — GW-004 and GW-014. `transport.send()` is async; called
//     without await or .catch inside a synchronous try/catch, a rejection becomes
//     an unhandled rejection and takes the whole process down. The rule finds
//     every such site in seconds, including three `transport.close()` calls that
//     no test or issue had identified.
//   no-misused-promises   — the same mistake in the other direction: passing an
//     async function where a void callback is expected, so nothing can observe
//     its failure. Every gateway registers async handlers on transports.
//
// `require-await` was tried and dropped: it flagged seven sites, all of them
// gateway entry points that are async for API shape, and no defects. A lint
// config that cries wolf gets switched off.
//
// Style is Prettier's job; this config adds no formatting opinions.
export default [
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: { project: './tsconfig.json' },
    },
    plugins: { '@typescript-eslint': tseslint },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
    },
  },
]
