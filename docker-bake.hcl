variable "VERSION" {
  default = "4.0.0"
}

variable "IMAGE_TAG" {
  default = "4.0.0-candidate"
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
    "supercorp/supergateway:${IMAGE_TAG}",
    "ghcr.io/supercorp-ai/supergateway:${IMAGE_TAG}"
  ]
}

target "uvx" {
  inherits   = ["common"]
  depends_on  = ["base"]
  dockerfile = "docker/uvx.Dockerfile"
  contexts = { base = "target:base" }
  tags = [
    "supercorp/supergateway:${IMAGE_TAG}-uvx",
    "ghcr.io/supercorp-ai/supergateway:${IMAGE_TAG}-uvx"
  ]
}

target "deno" {
  inherits   = ["common"]
  depends_on  = ["base"]
  dockerfile = "docker/deno.Dockerfile"
  contexts = { base = "target:base" }
  tags = [
    "supercorp/supergateway:${IMAGE_TAG}-deno",
    "ghcr.io/supercorp-ai/supergateway:${IMAGE_TAG}-deno"
  ]
}
