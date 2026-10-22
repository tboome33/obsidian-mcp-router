#!/usr/bin/env bash
# preflight-direct.sh — run ON THE HOST that runs the Obsidian container, BEFORE installing
# view-agent-direct. Read-only: changes nothing. Checks the deployment assumptions and
# prints the values to copy into config.json.
#
#   bash deploy/preflight-direct.sh [vault-rest-port] [agent-port]     (defaults 27180 27200)
set -u
PORT="${1:-27180}"
AGENT_PORT="${2:-27200}"
ok()   { printf '  \033[32mOK\033[0m   %s\n' "$*"; }
ko()   { printf '  \033[31mKO\033[0m   %s\n' "$*"; }
info() { printf '  --   %s\n' "$*"; }

echo "== 1. Obsidian container publishing port $PORT"
C=$(docker ps --format '{{.Names}}\t{{.Ports}}' | awk -v p=":$PORT->" 'index($0,p){print $1; exit}')
if [ -z "$C" ]; then
  C=$(docker ps --format '{{.Names}}' | grep -i obsidian | head -1)
  [ -n "$C" ] && info "port $PORT not published; candidate Obsidian container: $C" || ko "no running Obsidian container"
else
  ok "container: $C"
fi
[ -z "$C" ] && exit 1

NET=$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$C")
# The REST port INSIDE the container (open_port) may differ from the published one.
INNER=$(docker port "$C" 2>/dev/null | awk -v p=":$PORT" '$3 ~ p"$" {split($1,a,"/"); print a[1]; exit}')
INNER="${INNER:-$PORT}"
[ "$INNER" != "$PORT" ] && info "host port $PORT → container port $INNER (open_port = $INNER)"
info "network mode: $NET"
if [ "$NET" = "host" ]; then
  info "→ open_mode \"http\" with open_url http://127.0.0.1:$PORT works (the bridge sees 127.0.0.1)"
else
  info "→ open_mode \"docker-exec\" required (from the host, the bridge would see the Docker bridge IP, not loopback)"
fi

info "published ports (detect.gui_container_ports must name the GUI's container-side port):"
docker inspect -f '{{range $p, $b := .NetworkSettings.Ports}}{{range $b}}{{$p}} <- {{.HostIp}}:{{.HostPort}}  {{end}}{{end}}' "$C" | tr -s ' ' '\n' | paste -d' ' - - - | sed 's/^/         /'
N=$(docker ps --format '{{.Ports}}' | grep -c ":$PORT->")
[ "$N" -gt 1 ] && info "$N containers publish $PORT: detection refuses it unless their host IPs differ"

echo "== 2. curl available inside the container"
if docker exec "$C" sh -c 'command -v curl' >/dev/null 2>&1; then ok "curl present"; else ko "curl missing in $C (install it, or set curl_path)"; fi

echo "== 3. Bridge click-to-open route, seen from the container's loopback"
# The prefix is the one the bridge announces in /ping: /mcp-router-bridge/open/ on bridge
# 0.10.0+ (Local REST API 5.4.0 reserves /open/), /open/ for an older bridge — exactly what
# view-agent-direct.py does at click time.
SCHEME=http; K=
PONG=$(docker exec "$C" curl -sS --max-time 3 "http://127.0.0.1:$INNER/ping" 2>/dev/null)
if [ -z "$PONG" ]; then  # perhaps the REST API's TLS port: open_scheme "https"
  PONG=$(docker exec "$C" curl -sSk --max-time 3 "https://127.0.0.1:$INNER/ping" 2>/dev/null)
  [ -n "$PONG" ] && { SCHEME=https; K=k; info "port $INNER answers over https → open_scheme \"https\""; }
fi
PREFIX=$(printf '%s' "$PONG" | sed -n 's|.*"openPrefix"[[:space:]]*:[[:space:]]*"\(/[A-Za-z0-9._~/-]*/\)".*|\1|p')
case "$PREFIX" in */.*|"") PREFIX=/open/ ;; esac  # no dot-leading segment, like the agent
info "bridge open prefix: $PREFIX"
CODE=$(docker exec "$C" curl -sS$K -o /dev/null -w '%{http_code}' --max-time 4 "$SCHEME://127.0.0.1:$INNER${PREFIX}__preflight_missing__.md" 2>/dev/null)
CODE="${CODE:-000}"
case "$CODE" in
  404) ok "HTTP 404: $PREFIX is registered and the loopback guard is satisfied" ;;
  403) ko "HTTP 403: the call is not seen as loopback (bindingHost? proxy?)" ;;
  401) ko "HTTP 401: $PREFIX not registered (bridge < 0.2.0, Local REST API < 4.0.0, Local REST API 5.4.0 with bridge < 0.10.0, or reload Obsidian)" ;;
  000) ko "no answer on 127.0.0.1:$INNER inside the container (non-encrypted HTTP server disabled?)" ;;
  *)   info "HTTP $CODE (unexpected)" ;;
esac

echo "== 4. Agent port $AGENT_PORT free on the host"
if ss -ltn 2>/dev/null | grep -q ":$AGENT_PORT "; then ko "$AGENT_PORT already in use: $(ss -ltnp 2>/dev/null | grep ":$AGENT_PORT " | head -1)"; else ok "$AGENT_PORT free"; fi

echo "== 5. Firewall (UFW) rule for $AGENT_PORT"
if command -v ufw >/dev/null 2>&1; then
  sudo ufw status 2>/dev/null | grep -q "$AGENT_PORT" && ok "UFW rule present for $AGENT_PORT" || info "no UFW rule for $AGENT_PORT → sudo ufw allow from <your-vpn-subnet> to any port $AGENT_PORT proto tcp"
else
  info "ufw not installed"
fi

echo "== 6. Service user"
id viewagent >/dev/null 2>&1 && ok "user viewagent exists" || info "create it: sudo useradd -r -s /usr/sbin/nologin -G docker viewagent"

echo
echo "Values for config.json: container=\"$C\"  open_port=$INNER  open_mode=$([ "$NET" = host ] && echo http || echo docker-exec)"
