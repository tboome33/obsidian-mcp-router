#!/usr/bin/env bash
# add-vault.sh - deploy one Obsidian vault in its own Docker container
# (lscr.io/linuxserver/obsidian, web UI = Selkies), reachable over WireGuard only.
#
# Usage (as root, on the server):
#   add-vault.sh [--dry-run] <Name> <ui-port> <api-port> <vault-dir>
#
# Example:
#   PASSWORD='...' ./add-vault.sh Notes 3001 27180 /srv/vaults/notes
#
# Optional environment (defaults in brackets):
#   WG_IP      server address on the tunnel          [10.8.0.1]
#   WG_IFACE   WireGuard interface                   [wg0]
#   WG_NET     tunnel subnet allowed to connect      [10.8.0.0/24]
#   BASE_DIR   where compose projects live           [/opt/obsidian-vaults]
#   CUSTOM_USER  web UI user                         [obsidian]
#   PASSWORD     web UI password                     [prompted if unset]
#   PUID / PGID  file owner inside the container     [1000 / 1000]
#   TZ           time zone                           [/etc/timezone or Etc/UTC]
#
# What it does:
#   1. validates the arguments;
#   2. creates BASE_DIR/<slug>/ with a .env (mode 600) and the compose template;
#   3. docker compose up -d;
#   4. adds DOCKER-USER iptables rules so the two ports only answer on WG_IFACE
#      from WG_NET, saves them, and installs a boot-time unit that re-applies them;
#   5. prints the steps left to do by hand.
#
# --dry-run prints every action instead of running it. Nothing is written,
# no password is asked, no container is started, no rule is added.

set -euo pipefail

# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------
WG_IP="${WG_IP:-10.8.0.1}"
WG_IFACE="${WG_IFACE:-wg0}"
WG_NET="${WG_NET:-10.8.0.0/24}"
BASE_DIR="${BASE_DIR:-/opt/obsidian-vaults}"
CUSTOM_USER="${CUSTOM_USER:-obsidian}"
PUID="${PUID:-1000}"
PGID="${PGID:-1000}"
if [ -z "${TZ:-}" ]; then
  if [ -r /etc/timezone ]; then TZ="$(head -n1 /etc/timezone)"; else TZ="Etc/UTC"; fi
fi

FW_SCRIPT="/usr/local/sbin/obsidian-vaults-firewall"
FW_UNIT="/etc/systemd/system/obsidian-vaults-firewall.service"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TEMPLATE="${SCRIPT_DIR}/docker-compose.yml"

DRY_RUN=0

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }
info() { printf '==> %s\n' "$*"; }

# run CMD...  - execute, or only print it in dry-run mode.
run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '[dry-run] %s\n' "$*"
  else
    "$@"
  fi
}

usage() {
  sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-1}"
}

is_port() {
  case "$1" in ''|*[!0-9]*) return 1 ;; esac
  [ "${#1}" -le 5 ] && [ "$1" -ge 1 ] && [ "$1" -le 65535 ]
}

port_in_use() {
  command -v ss >/dev/null 2>&1 || return 1
  ss -Hltn "sport = :$1" 2>/dev/null | grep -q .
}

# ---------------------------------------------------------------------------
# Arguments
# ---------------------------------------------------------------------------
ARGS=()
for a in "$@"; do
  case "$a" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help) usage 0 ;;
    -*) die "unknown option: $a" ;;
    *) ARGS+=("$a") ;;
  esac
done
[ "${#ARGS[@]}" -eq 4 ] || usage 1

NAME="${ARGS[0]}"
UI_PORT="${ARGS[1]}"
API_PORT="${ARGS[2]}"
VAULT_DIR="${ARGS[3]}"

# Name: letters, digits, space, dot, dash, underscore; starts with a letter or digit.
printf '%s' "$NAME" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9 ._-]{0,62}$' \
  || die "name must be 1-63 chars: letters, digits, space . _ - (got: $NAME)"
VAULT_SLUG="$(printf '%s' "$NAME" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9_-]+/-/g; s/^-+//; s/-+$//')"
[ -n "$VAULT_SLUG" ] || die "name gives an empty slug: $NAME"

is_port "$UI_PORT"  || die "ui-port must be a number 1-65535 (got: $UI_PORT)"
is_port "$API_PORT" || die "api-port must be a number 1-65535 (got: $API_PORT)"
[ "$UI_PORT" != "$API_PORT" ] || die "ui-port and api-port must differ"
is_port "$PUID" || die "PUID must be numeric"
is_port "$PGID" || die "PGID must be numeric"

case "$VAULT_DIR" in
  /*) ;;
  *) die "vault-dir must be an absolute path (got: $VAULT_DIR)" ;;
esac
case "$VAULT_DIR" in
  *[[:space:]]*|*\'*|*\"*|*'$'*) die "vault-dir must not contain spaces, quotes or \$" ;;
esac

printf '%s' "$WG_IP" | grep -Eq '^[0-9]{1,3}(\.[0-9]{1,3}){3}$' || die "WG_IP is not an IPv4 address: $WG_IP"

PROJECT_DIR="${BASE_DIR}/${VAULT_SLUG}"

# ---------------------------------------------------------------------------
# Pre-flight checks
# ---------------------------------------------------------------------------
if [ "$DRY_RUN" -eq 0 ]; then
  [ "$(id -u)" -eq 0 ] || die "run as root (sudo)"
  command -v docker >/dev/null 2>&1 || die "docker is not installed"
  docker compose version >/dev/null 2>&1 || die "the docker compose plugin is missing"
  command -v iptables >/dev/null 2>&1 || die "iptables is not installed"
fi
[ -r "$TEMPLATE" ] || die "template not found: $TEMPLATE (keep add-vault.sh next to docker-compose.yml)"

if ip -4 addr show 2>/dev/null | grep -q "inet ${WG_IP}/"; then :; else
  printf 'warning: %s is not configured on this host yet (is %s up?). Docker will fail to bind.\n' "$WG_IP" "$WG_IFACE" >&2
fi
# A project folder that holds its .env and compose file is a previous run of
# this script (finished, or stopped half-way): it is resumed — the firewall
# rules and the container are brought to what they should be — never rebuilt.
RESUME=0
if [ -e "$PROJECT_DIR" ]; then
  if [ -f "$PROJECT_DIR/.env" ] && [ -f "$PROJECT_DIR/docker-compose.yml" ]; then
    RESUME=1
    # The firewall rules must match what the container will publish: the
    # values the project's .env was written with. A resume asked with other
    # values is refused rather than filtering one port and exposing another.
    env_value() { sed -n "s/^$1=//p" "$PROJECT_DIR/.env" | head -n 1; }
    for pair in "UI_PORT:$UI_PORT" "API_PORT:$API_PORT" "WG_IP:$WG_IP"; do
      key=${pair%%:*}; want=${pair#*:}; have=$(env_value "$key")
      [ "$have" = "$want" ] || die "$PROJECT_DIR/.env has $key=$have, not $want - rerun with the same values, or remove the folder to start over"
    done
  else
    die "$PROJECT_DIR exists but holds no .env and docker-compose.yml - pick another name or remove it first"
  fi
fi
if [ "$RESUME" -eq 0 ]; then
  port_in_use "$UI_PORT"  && die "port $UI_PORT is already listening on this host"
  port_in_use "$API_PORT" && die "port $API_PORT is already listening on this host"
fi

# ---------------------------------------------------------------------------
# Password (never printed, never on the command line)
# ---------------------------------------------------------------------------
if [ "$DRY_RUN" -eq 1 ] || [ "$RESUME" -eq 1 ]; then
  # A resumed project keeps the password its .env already holds.
  PASSWORD="<hidden>"
elif [ -z "${PASSWORD:-}" ]; then
  [ -t 0 ] || die "PASSWORD is not set and there is no terminal to ask for it"
  printf 'Web UI password for user %s: ' "$CUSTOM_USER" >&2
  IFS= read -rs PASSWORD; printf '\n' >&2
  printf 'Again: ' >&2
  IFS= read -rs PASSWORD2; printf '\n' >&2
  [ "$PASSWORD" = "$PASSWORD2" ] || die "passwords do not match"
  unset PASSWORD2
fi
[ "${#PASSWORD}" -ge 8 ] || die "password must be at least 8 characters"
case "$PASSWORD" in
  *\'*) die "password must not contain a single quote (')" ;;
esac
case "$CUSTOM_USER" in
  ''|*[!A-Za-z0-9._-]*) die "CUSTOM_USER must be letters, digits, . _ - only" ;;
esac

# ---------------------------------------------------------------------------
# 1. Project folder, .env, compose file
# ---------------------------------------------------------------------------
info "Vault \"$NAME\" -> slug $VAULT_SLUG, project $PROJECT_DIR"
if [ "$RESUME" -eq 1 ]; then
  info "Resuming: $PROJECT_DIR already holds .env and docker-compose.yml (kept as they are)"
fi

if [ "$RESUME" -eq 0 ] && [ ! -d "$VAULT_DIR" ]; then
  info "Creating vault folder $VAULT_DIR"
  run mkdir -p "$VAULT_DIR"
  run chown "$PUID:$PGID" "$VAULT_DIR"
fi

if [ "$RESUME" -eq 0 ]; then
  run mkdir -p "$PROJECT_DIR/config-$VAULT_SLUG"
  run chown "$PUID:$PGID" "$PROJECT_DIR/config-$VAULT_SLUG"
  run cp "$TEMPLATE" "$PROJECT_DIR/docker-compose.yml"
fi

write_env() {
  umask 077
  cat >"$PROJECT_DIR/.env" <<EOF
# Written by add-vault.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ). Holds a secret: keep mode 600.
VAULT_SLUG=$VAULT_SLUG
WG_IP=$WG_IP
UI_PORT=$UI_PORT
API_PORT=$API_PORT
VAULT_DIR=$VAULT_DIR
CUSTOM_USER=$CUSTOM_USER
PASSWORD='$PASSWORD'
PUID=$PUID
PGID=$PGID
TZ=$TZ
EOF
  chmod 600 "$PROJECT_DIR/.env"
}
if [ "$RESUME" -eq 1 ]; then
  :
elif [ "$DRY_RUN" -eq 1 ]; then
  printf '[dry-run] write %s/.env (mode 600): VAULT_SLUG=%s WG_IP=%s UI_PORT=%s API_PORT=%s VAULT_DIR=%s CUSTOM_USER=%s PASSWORD=<hidden> PUID=%s PGID=%s TZ=%s\n' \
    "$PROJECT_DIR" "$VAULT_SLUG" "$WG_IP" "$UI_PORT" "$API_PORT" "$VAULT_DIR" "$CUSTOM_USER" "$PUID" "$PGID" "$TZ"
else
  (write_env)
fi

# ---------------------------------------------------------------------------
# 2. Firewall (DOCKER-USER chain), before the container starts
# ---------------------------------------------------------------------------
# Docker-published ports bypass ufw: filtering has to happen in DOCKER-USER.
# DOCKER-USER sees packets AFTER DNAT, so the destination port there is the
# CONTAINER port. The UI is published UI_PORT->3001, so it is matched with
# conntrack --ctorigdstport UI_PORT (the port the client really asked for).
# The API has the same port on both sides, so --dport works.
#
# Order in the chain (top first): RETURN from the tunnel, then DROP the rest.
# We insert the DROP first and the RETURN second, because -I puts a rule on top.
RULES_FILE="$PROJECT_DIR/firewall.rules"
# --ctorigdst WG_IP limits every rule to connections that were really aimed at
# this server, so unrelated container traffic using the same port numbers is
# never touched.
# --ctdir ORIGINAL: the conntrack origin fields are the same on the container's
# replies, so without it the SYN-ACK going back to the tunnel would match the
# DROP and the web UI would never answer. Only the client's direction is
# filtered; replies follow the connection the RETURN let in.
RULES=(
  "-p tcp -m conntrack --ctdir ORIGINAL --ctorigdst $WG_IP --ctorigdstport $UI_PORT -j DROP"
  "-i $WG_IFACE -s $WG_NET -p tcp -m conntrack --ctdir ORIGINAL --ctorigdst $WG_IP --ctorigdstport $UI_PORT -j RETURN"
  "-p tcp --dport $API_PORT -m conntrack --ctdir ORIGINAL --ctorigdst $WG_IP -j DROP"
  "-i $WG_IFACE -s $WG_NET -p tcp --dport $API_PORT -m conntrack --ctdir ORIGINAL --ctorigdst $WG_IP -j RETURN"
)

info "Adding DOCKER-USER rules (tunnel $WG_IFACE $WG_NET only)"
for r in "${RULES[@]}"; do
  # shellcheck disable=SC2086  # word splitting of the rule spec is intended
  if [ "$DRY_RUN" -eq 0 ] && iptables -C DOCKER-USER $r 2>/dev/null; then
    printf '    already present: %s\n' "$r"
  else
    # shellcheck disable=SC2086
    run iptables -I DOCKER-USER $r
  fi
done

if [ "$DRY_RUN" -eq 1 ]; then
  printf '[dry-run] write %s (the 4 rules above, one per line)\n' "$RULES_FILE"
else
  printf '%s\n' "${RULES[@]}" >"$RULES_FILE"
fi

# Boot-time re-apply: one script + one systemd unit for all vaults. Written at
# every run, not only the first: an install made by an older version of this
# script gets the current unit (rules restored BEFORE Docker) too.
if true; then
  info "Installing $FW_SCRIPT and $(basename "$FW_UNIT") (re-applies the rules at boot)"
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '[dry-run] write %s and %s; systemctl enable obsidian-vaults-firewall.service\n' "$FW_SCRIPT" "$FW_UNIT"
  else
    # The folder is written as a quoted shell word (printf %q): a path with a
    # space or a $(...) in it stays a path in the boot script, never code.
    BASE_DIR_QUOTED=$(printf '%q' "$BASE_DIR")
    cat >"$FW_SCRIPT" <<EOF
#!/usr/bin/env bash
# Re-applies the DOCKER-USER rules of every vault in <base>/*/firewall.rules.
# Each file lists rules top-down as they were inserted (DROP, then RETURN).
set -euo pipefail
base=$BASE_DIR_QUOTED
iptables -N DOCKER-USER 2>/dev/null || true
for f in "\$base"/*/firewall.rules; do
  [ -r "\$f" ] || continue
  while IFS= read -r r; do
    [ -n "\$r" ] || continue
    # shellcheck disable=SC2086
    iptables -C DOCKER-USER \$r 2>/dev/null || iptables -I DOCKER-USER \$r
  done <"\$f"
done
EOF
    chmod 755 "$FW_SCRIPT"
    cat >"$FW_UNIT" <<EOF
[Unit]
Description=DOCKER-USER rules for the Obsidian vault containers
# Before Docker: the containers restart on their own (unless-stopped), so the
# rules must be in place before Docker brings them back. The script creates
# the DOCKER-USER chain itself; Docker keeps a chain that already exists.
Before=docker.service
After=network-pre.target
Wants=network-pre.target

[Service]
Type=oneshot
ExecStart=$FW_SCRIPT
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target docker.service
EOF
    systemctl daemon-reload
    systemctl enable obsidian-vaults-firewall.service >/dev/null
  fi
fi

# ---------------------------------------------------------------------------
# 3. Start the container (after its firewall rules: never exposed unfiltered)
# ---------------------------------------------------------------------------
info "Starting the container"
run docker compose --project-directory "$PROJECT_DIR" -f "$PROJECT_DIR/docker-compose.yml" up -d

# ---------------------------------------------------------------------------
# 4. Next steps
# ---------------------------------------------------------------------------
cat <<EOF

Done. Vault "$NAME" (slug $VAULT_SLUG).
  Web UI   : https://$WG_IP:$UI_PORT/   (self-signed certificate, user $CUSTOM_USER)
  REST API : http://$WG_IP:$API_PORT/   (answers only after the steps below)
  Project  : $PROJECT_DIR

Left to do by hand:
  1. Open https://$WG_IP:$UI_PORT/ from a machine on the tunnel, log in,
     open the folder /vaults/$VAULT_SLUG as a vault, and click
     "Trust author and enable plugins" once (for a new empty vault:
     Settings > Community plugins > Turn on community plugins).
     Until then the REST API answers nothing.
  2. Install and enable the "Local REST API" community plugin, then make it
     listen on port $API_PORT, bound to 0.0.0.0 (not 127.0.0.1):
     Settings > Local REST API (or edit, on the host,
     $VAULT_DIR/.obsidian/plugins/obsidian-local-rest-api/data.json:
     "insecurePort": $API_PORT, "enableInsecureServer": true, and the binding
     host 0.0.0.0), then restart the container:
       docker restart obsidian-$VAULT_SLUG
     Copy the API key shown in the plugin settings.
  3. Check from your PC:  curl http://$WG_IP:$API_PORT/
     It should answer JSON with "status": "OK".
  4. In Claude Code, obsidian-router "Vaults" pane > Administration >
     Register a vault > Remote (over WireGuard): IP $WG_IP, port $API_PORT,
     HTTP, web UI port $UI_PORT, the API key.
  5. Check the firewall counters:  iptables -L DOCKER-USER -v -n --line-numbers
EOF
