import { test } from 'node:test'

// GW-007 in MCDC_E2E_FINDINGS.md: no public error-normalization API exists yet.
// Acceptance cases are recorded there; these are specifications, not runnable
// regressions against a proposed implementation.
test.todo('GW-007: bridge error conversion handles malformed error properties')
test.todo(
  'GW-007: bridge error conversion preserves codes and trims matching prefixes',
)
