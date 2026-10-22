#!/usr/bin/env bash
# (Re)launch the view-agent if it is not already running.
# Idempotent — safe to run from cron: @reboot for boot, */2 * * * * for crash recovery.
#
#   crontab example:
#     @reboot      /opt/view-agent/deploy/start-view-agent.sh
#     */2 * * * *  /opt/view-agent/deploy/start-view-agent.sh
#
# Adjust the three variables to your install. HEALTH_URL must match bind+port in config.json.
AGENT_DIR="/opt/view-agent"
CONFIG="$AGENT_DIR/config.json"
HEALTH_URL="http://127.0.0.1:27200/health"

# Consecutive-failure counter: balances two failure modes that pull opposite ways —
# (a) a LIVE agent answering slowly (loaded host) must not be killed on one slow tick,
# (b) a WEDGED agent (process alive, handler stuck / wrong port) must not be shielded
# forever just because its process exists. We tolerate MAX_FAILS-1 consecutive failed
# probes while a process is alive, then declare it wedged and restart it anyway
# (with cron */2 + MAX_FAILS=3, a wedged agent is recycled within ~6 minutes).
# State + log live in AGENT_DIR (owned by the service user), NOT in world-writable /tmp:
# with this launcher in a root crontab, a fixed /tmp path could be pre-created as a
# symlink by another local user and the `>` redirect would truncate the target with the
# launcher's privileges (review pass 5).
STATE_FILE="$AGENT_DIR/.unhealthy-count"
LOG_FILE="$AGENT_DIR/view-agent.log"
MAX_FAILS=3

if curl -s --max-time 3 "$HEALTH_URL" >/dev/null 2>&1; then
  rm -f "$STATE_FILE"
  exit 0                                    # healthy -> no-op
fi

COUNT=$(( $(cat "$STATE_FILE" 2>/dev/null || echo 0) + 1 ))
echo "$COUNT" > "$STATE_FILE"

if pgrep -f "python3 .*view-agent\.py" >/dev/null 2>&1 && [ "$COUNT" -lt "$MAX_FAILS" ]; then
  exit 0                                    # alive but slow -> give it another tick
fi

# Dead — or alive-but-wedged past the tolerance: restart it. Kill the stale agent first
# (else the relaunch dies on EADDRINUSE), then its orphan QUICK tunnels. The cloudflared
# pattern targets quick tunnels only (`tunnel --url ...`) — NAMED production tunnels
# (`cloudflared tunnel run <name>`) don't match. If this host runs OTHER quick-tunnel
# services, narrow the pattern further (or use the systemd unit instead:
# KillMode=control-group reaps children deterministically, no pkill needed).
rm -f "$STATE_FILE"
pkill -f "python3 .*view-agent\.py" 2>/dev/null
pkill -f "cloudflared.*tunnel.*--url" 2>/dev/null
sleep 1
setsid python3 "$AGENT_DIR/view-agent.py" "$CONFIG" > "$LOG_FILE" 2>&1 < /dev/null &
