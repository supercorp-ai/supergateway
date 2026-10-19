// How long a test waits, scaled to the host it runs on. A module of its own,
// importing nothing, so that every helper can use it without an import cycle.

// Eight seconds is many times the healthy worst case: across a full soak the
// slowest relay-edge gateway reached its ready line in under four. The override
// exists so a loaded runner can be given headroom without editing this file —
// raising it hides nothing, because the failure message now reports how long
// the gateway actually took and whether it ever ran at all.
export const readyTimeout = () => {
  // A workflow that sets this per-platform hands every other platform an empty
  // string, and `??` does not fall back on one — `Number('')` is 0, which would
  // silently give every gateway a zero-millisecond budget. Only a positive
  // number overrides the default.
  const configured = Number(process.env.SUPERGATEWAY_TEST_READY_TIMEOUT)
  return Number.isFinite(configured) && configured > 0 ? configured : 8000
}

// How much slower this platform is assumed to be, taken from the one knob a
// workflow already sets. A runner that needs four times as long to get a
// gateway listening needs the same slack for the requests that follow it, and
// deriving both from one signal stops them drifting apart.
export const slowHostFactor = () => readyTimeout() / 8000

// A client request budget inside a test. These are setup, not assertions: the
// tests carrying them check which protocol era is negotiated or what a response
// contains, never how fast the round trip was. Three campaigns have now been
// lost to one of them firing on a transient stall.
export const requestTimeout = (ms: number) => Math.round(ms * slowHostFactor())
