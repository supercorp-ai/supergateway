variable "VERSION" {
  default = "4.0.0"
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
  tags = [
    "supercorp/supergateway:${VERSION}-candidate",
    "ghcr.io/supercorp-ai/supergateway:${VERSION}-candidate"
  ]
}

target "uvx" {
  inherits   = ["common"]
  depends_on  = ["base"]
  dockerfile = "docker/uvx.Dockerfile"
  contexts = { base = "target:base" }
  tags = [
    "supercorp/supergateway:${VERSION}-candidate-uvx",
    "ghcr.io/supercorp-ai/supergateway:${VERSION}-candidate-uvx"
  ]
}

target "deno" {
  inherits   = ["common"]
  depends_on  = ["base"]
  dockerfile = "docker/deno.Dockerfile"
  contexts = { base = "target:base" }
  tags = [
    "supercorp/supergateway:${VERSION}-candidate-deno",
    "ghcr.io/supercorp-ai/supergateway:${VERSION}-candidate-deno"
  ]
}
