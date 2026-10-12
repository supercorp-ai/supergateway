// The JSON-RPC error code of a header that does not mirror the body.
export const HEADER_MISMATCH = -32020

export class HeaderMismatch extends Error {
  readonly code = HEADER_MISMATCH
  constructor(readonly header: string) {
    super(`Request header ${header} does not match the request body`)
  }
}

export type ReadHeader = (name: string) => string | undefined
