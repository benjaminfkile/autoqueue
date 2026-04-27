#!/bin/sh
# Grunt runner entrypoint.
#
# When GRUNT_SECRETS_FROM_STDIN=1 is set, the host (claudeRunner) is delivering
# secret KEY=value lines via this process's stdin. We capture them into a
# tmpfs-backed file (mounted at /run/grunt-secrets via `docker run --tmpfs`),
# load them into the environment, and unlink the file before exec'ing the
# command. This keeps secrets out of `docker inspect` (no -e for the values)
# and off disk (tmpfs is RAM-only).
set -eu

if [ "${GRUNT_SECRETS_FROM_STDIN:-0}" = "1" ]; then
  SECRETS_FILE="/run/grunt-secrets/env"

  # umask before write so the file lands at 0600 even though the parent dir
  # is sticky-world-writable (mode 01777, set by --tmpfs to allow non-root
  # creation).
  umask 077
  cat > "$SECRETS_FILE"

  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      ''|'#'*) continue ;;
      *=*)
        key=${line%%=*}
        value=${line#*=}
        export "$key=$value"
        ;;
    esac
  done < "$SECRETS_FILE"

  rm -f "$SECRETS_FILE"
  unset GRUNT_SECRETS_FROM_STDIN
fi

exec "$@"
