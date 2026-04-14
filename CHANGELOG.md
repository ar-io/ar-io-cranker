# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-04-14

Initial extraction from `ar-io/solana-ar-io@/cranker` as a standalone
private repo. Drives the AR.IO Network's permissionless 6-step epoch
pipeline (create → tally → prescribe → distribute → close).

### Added
- Standalone Node.js daemon (CLI + health/metrics HTTP server)
- Multi-arch Docker image (`linux/amd64` + `linux/arm64`) published to GHCR
- Docker Compose, Kubernetes, and systemd deployment manifests
- Operations guide with Prometheus alert templates
