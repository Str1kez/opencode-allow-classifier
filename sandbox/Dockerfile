FROM node:26-bookworm-slim

# OpenCode V2 ships a standalone binary. The npm package `opencode-ai` is V1 and
# would install a different CLI, so the version and both digests are pinned here.
ARG OPENCODE_VERSION=2.2.4
ARG TARGETARCH=arm64

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git jq ripgrep util-linux \
 && rm -rf /var/lib/apt/lists/*

RUN set -eu; \
    case "${TARGETARCH}" in \
      arm64) asset="opencode-linux-arm64.tar.gz"; \
             digest="81edcae078f36356cde3cf57d0cc6627896b18d1bddf47317cb025c56fcffd93" ;; \
      amd64) asset="opencode-linux-x64-baseline.tar.gz"; \
             digest="1b70ce4a88e27c3643c2bb61c757dfe173b4e3629926ce808d45f3774d87826e" ;; \
      *) echo "unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    url="https://opencode.ai/files/bin/${OPENCODE_VERSION}/${asset}"; \
    curl -fsSL "${url}" -o /tmp/opencode.tar.gz; \
    echo "${digest}  /tmp/opencode.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/opencode.tar.gz -C /usr/local/bin; \
    chmod +x /usr/local/bin/opencode; \
    rm /tmp/opencode.tar.gz

# Runs as root only long enough to take ownership of fresh named volumes, then
# drops to the image `node` user. See entrypoint.sh.
COPY entrypoint.sh /usr/local/bin/sandbox-entrypoint
RUN chmod +x /usr/local/bin/sandbox-entrypoint

ENV OPENCODE_DISABLE_AUTOUPDATE=1
# setpriv keeps the environment, so HOME has to be right before the drop.
ENV HOME=/home/node
ENV npm_config_cache=/home/node/.npm

WORKDIR /home/node/repo
ENTRYPOINT ["/usr/local/bin/sandbox-entrypoint"]
CMD ["opencode", "--help"]
