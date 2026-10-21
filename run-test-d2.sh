#!/bin/bash
# Test D2 driver.
#
# Runs test-d2-network.js inside an isolated network namespace backed by
# slirp4netns, then performs a REAL network outage by installing iptables
# rules inside the namespace (all traffic blackholed), and finally restores
# connectivity by flushing the rules.
#
# Requirements validated locally:
#   unshare -rn --mount      -> user + net + mount namespace
#   slirp4netns --configure --mtu=1500  -> user-mode NAT (MTU 65520 breaks TCP)
#   bind-mount resolv.conf with nameserver 10.0.2.3 (slirp's DNS proxy)
#   iptables inside the netns -> CAP_NET_ADMIN is available in the userns
set -u
cd "$(dirname "$0")"

PIDFILE=/tmp/opencode/d2-netns.pid
OUT=logs/test-d2.out
RESOLV=/tmp/opencode/d2-resolv.conf
mkdir -p logs
rm -f "$PIDFILE" "$OUT"

printf 'nameserver 10.0.2.3\n' > "$RESOLV"

cat > /tmp/opencode/d2-inner.sh <<INNER
#!/bin/bash
mount --bind "$RESOLV" /etc/resolv.conf 2>/dev/null
ip link set lo up
echo \$\$ > "$PIDFILE"

# Wait for the slirp tap to appear, then start the test process.
for i in \$(seq 1 40); do ip link show tap0 >/dev/null 2>&1 && break; sleep 0.5; done
node test-d2-network.js &
NODE_PID=\$!

# Wait for the initial connection to be established.
for i in \$(seq 1 90); do
  grep -q "initial connect OK" "$OUT" 2>/dev/null && break
  kill -0 \$NODE_PID 2>/dev/null || break
  sleep 1
done
echo "[driver] node pid=\$NODE_PID initial-connect-detected=\$(grep -c 'initial connect OK' "$OUT" 2>/dev/null)"

# ---- PHASE 1: real network blackout (DROP all traffic) ----
echo "[driver] PHASE 1: installing iptables blackout rules"
iptables -A OUTPUT -j DROP
iptables -A INPUT -j DROP
echo "[driver] blackout at \$(date -Is)"
sleep 45
echo "[driver] restoring connectivity (flush rules)"
iptables -F OUTPUT
iptables -F INPUT
echo "[driver] restored at \$(date -Is)"

# ---- PHASE 2: hard reset of live connections (RST) ----
sleep 20
echo "[driver] PHASE 2: injecting TCP RST on inbound traffic"
iptables -A INPUT -p tcp -j REJECT --reject-with tcp-reset
echo "[driver] rst-injected at \$(date -Is)"
sleep 25
iptables -F INPUT
echo "[driver] cleared RST rule at \$(date -Is)"

wait \$NODE_PID
echo "[driver] node exited"
exit 0
INNER
chmod +x /tmp/opencode/d2-inner.sh

setsid unshare -rn --mount --fork /tmp/opencode/d2-inner.sh </dev/null >"$OUT" 2>&1 &
for _ in $(seq 1 60); do [ -s "$PIDFILE" ] && break; sleep 0.5; done
NSPID=$(cat "$PIDFILE" 2>/dev/null)
echo "[driver] netns pid=$NSPID"

setsid slirp4netns --configure --mtu=1500 "$NSPID" tap0 </dev/null >logs/slirp-d2.log 2>&1 &
SLIRP=$!

wait
echo "[driver] done"
kill "$SLIRP" 2>/dev/null
exit 0
