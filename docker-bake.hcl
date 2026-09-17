variable "VERSION" {
  default = "DEV"
}

variable "CHANNEL" {
  default = "next"
  validation {
    condition = contains(["latest", "next"], CHANNEL)
    error_message = "CHANNEL must be latest or next."
  }
}

variable "PACKAGE_SHA256" {
  default = ""
}

target "common" {
  args = { VERSION = VERSION, PACKAGE_SHA256 = PACKAGE_SHA256 }
  context   = "."
  platforms = ["linux/amd64", "linux/arm64"]
}

group "default" {
  targets = ["base", "uvx", "deno"]
}

target "base" {
  inherits   = ["common"]
  dockerfile = "docker/base.Dockerfile"
  tags = concat([
    "supercorp/supergateway:${CHANNEL}",
    "supercorp/supergateway:${VERSION}",
    "ghcr.io/supercorp-ai/supergateway:${CHANNEL}",
    "ghcr.io/supercorp-ai/supergateway:${VERSION}"
  ], CHANNEL == "latest" ? [
    "supercorp/supergateway:base",
    "ghcr.io/supercorp-ai/supergateway:base"
  ] : [])
}

target "uvx" {
  inherits   = ["common"]
  depends_on  = ["base"]
  dockerfile = "docker/uvx.Dockerfile"
  contexts = { base = "target:base" }
  tags = [
    "supercorp/supergateway:${CHANNEL == "latest" ? "uvx" : "next-uvx"}",
    "supercorp/supergateway:${VERSION}-uvx",
    "ghcr.io/supercorp-ai/supergateway:${CHANNEL == "latest" ? "uvx" : "next-uvx"}",
    "ghcr.io/supercorp-ai/supergateway:${VERSION}-uvx"
  ]
}

target "deno" {
  inherits   = ["common"]
  depends_on  = ["base"]
  dockerfile = "docker/deno.Dockerfile"
  contexts = { base = "target:base" }
  tags = [
    "supercorp/supergateway:${CHANNEL == "latest" ? "deno" : "next-deno"}",
    "supercorp/supergateway:${VERSION}-deno",
    "ghcr.io/supercorp-ai/supergateway:${CHANNEL == "latest" ? "deno" : "next-deno"}",
    "ghcr.io/supercorp-ai/supergateway:${VERSION}-deno"
  ]
}
