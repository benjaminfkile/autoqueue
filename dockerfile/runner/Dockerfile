# syntax=docker/dockerfile:1.6
#
# Runner image for grunt's task execution layer (Phase 9).
#
# Each grunt task runs inside a fresh container of this image with the primary
# repo bind-mounted at /workspace. The image is internal-only — it is never
# pushed to a registry and exposes no ports.

FROM node:20-slim

# git: required for the repo work the agent performs (status/diff/branch/commit).
# openssh-client: lets git use SSH remotes when a key is mounted in.
# ca-certificates: TLS roots for the Anthropic API and the npm registry.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
        ca-certificates \
        git \
        openssh-client \
 && rm -rf /var/lib/apt/lists/*

# Install the Claude CLI globally so `claude` is on PATH for the runtime user.
# Default to `latest` so a fresh build picks up new releases; release builds
# can pin via `--build-arg CLAUDE_CLI_VERSION=x.y.z` for reproducibility.
ARG CLAUDE_CLI_VERSION=latest
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CLI_VERSION} \
 && npm cache clean --force

# Run as the unprivileged `node` user (uid/gid 1000) that ships with the
# official image. Pre-create the workspace and chown it so a bind-mount from
# a uid-1000 host user is writable without further setup.
RUN mkdir -p /workspace && chown -R node:node /workspace

ENV HOME=/home/node
USER node
WORKDIR /workspace

# Default command doubles as a smoke test: `docker run grunt/runner` prints
# the CLI version. The task runner overrides this with the real invocation.
CMD ["claude", "--version"]
