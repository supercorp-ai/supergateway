import type { CorsOptions } from 'cors'

export const serializeCorsOrigin = ({
  corsOrigin,
}: {
  corsOrigin: CorsOptions['origin']
}) =>
  JSON.stringify(corsOrigin, (_key, value) => {
    if (value instanceof RegExp) {
      return value.toString()
    }

    return value
  })
