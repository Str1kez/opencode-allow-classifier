#!/bin/sh
# Docker creates named volumes owned by root. OpenCode and npm run as `node`,
# so the first start takes ownership of every writable path and then drops
# privileges for good.
set -eu

NODE_UID=1000
NODE_GID=1000

if [ "$(id -u)" = "0" ]; then
  for dir in /home/node/.local/share/opencode /home/node/.local/state /home/node/.cache/opencode /home/node/.config/opencode /sandbox-runtime; do
    mkdir -p "$dir"
    chown "$NODE_UID:$NODE_GID" "$dir"
  done

  # OpenCode writes runtime files (service.json) into its config directory, so
  # that directory is a volume. The profile itself stays versioned in the repo
  # and is copied over on every start.
  cp /opt/sandbox-config/opencode.jsonc /home/node/.config/opencode/opencode.jsonc
  chown "$NODE_UID:$NODE_GID" /home/node/.config/opencode/opencode.jsonc

  if [ -d /home/node/repo/node_modules ]; then
    chown "$NODE_UID:$NODE_GID" /home/node/repo/node_modules
  fi

  exec setpriv --reuid="$NODE_UID" --regid="$NODE_GID" --init-groups "$0" "$@"
fi

# The repo is bind-mounted, its dependencies live in a named volume so the
# macOS install never mixes with the Linux one. Installed once per volume.
if [ -f package.json ] && [ ! -f node_modules/.package-lock.json ]; then
  echo "sandbox: installing node dependencies" >&2
  npm ci --no-audit --no-fund
fi

exec "$@"
