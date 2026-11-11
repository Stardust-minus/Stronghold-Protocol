#!/bin/bash
# tools/lanebench-netns.sh <outdir> <seconds> <clients/group> — tools/lanebench.mjs over a lossy path (docs/LATENCY.md,
# Lanes). Root on a test machine, never a server in use: it loads sch_netem / tcp_bbr and creates two netns joined by a veth pair:
# lns (server, 10.231.0.1, TCP sysctls like the entry) and lnc (clients, Linux defaults). netem on both egresses:
# 20 ms one way (RTT 40 ms) and the scenario's loss. Root-ns TCP sysctls are checked unchanged; the netns go at exit.
set -u
OUT=$1; SECS=$2; PER=$3
W=$(cd "$(dirname "$0")/.." && pwd)
mkdir -p "$OUT"
KEYS="net.ipv4.tcp_congestion_control net.ipv4.tcp_thin_linear_timeouts net.ipv4.tcp_slow_start_after_idle net.ipv4.tcp_notsent_lowat net.ipv4.tcp_retries2 net.ipv4.tcp_mtu_probing"
before=$(sysctl -n $KEYS | tr '\n' ' ')
cleanup() { ip netns del lns 2>/dev/null; ip netns del lnc 2>/dev/null; }
trap cleanup EXIT
cleanup
modprobe sch_netem; modprobe tcp_bbr
ip netns add lns; ip netns add lnc
ip link add lv-s type veth peer name lv-c
ip link set lv-s netns lns; ip link set lv-c netns lnc
ip -n lns addr add 10.231.0.1/30 dev lv-s; ip -n lnc addr add 10.231.0.2/30 dev lv-c
for n in lns lnc; do ip -n $n link set lo up; done
ip -n lns link set lv-s up; ip -n lnc link set lv-c up
ip netns exec lns sysctl -q -w net.ipv4.tcp_congestion_control=bbr net.ipv4.tcp_thin_linear_timeouts=1 net.ipv4.tcp_slow_start_after_idle=0 \
  net.ipv4.tcp_notsent_lowat=16384 net.ipv4.tcp_retries2=8 net.ipv4.tcp_mtu_probing=1
after=$(sysctl -n $KEYS | tr '\n' ' ')
[ "$before" = "$after" ] || { echo "ROOT SYSCTL CHANGED: $before -> $after"; exit 9; }
echo "server ns: $(ip netns exec lns sysctl -n $KEYS | tr '\n' ' ')"
echo "client ns: $(ip netns exec lnc sysctl -n $KEYS | tr '\n' ' ')"
run() { # name, netem loss spec
  local name=$1; shift
  ip netns exec lns tc qdisc replace dev lv-s root netem delay 20ms limit 10000 "$@"
  ip netns exec lnc tc qdisc replace dev lv-c root netem delay 20ms limit 10000 "$@"
  echo "== $name: $(ip netns exec lns tc qdisc show dev lv-s)"
  ip netns exec lns node $W/tools/lanebench.mjs server --host 10.231.0.1 --port 18765 --seconds $((SECS + 8)) --out "$OUT/$name.server.json" > "$OUT/$name.server.log" 2>&1 &
  local sp=$!
  sleep 1
  ip netns exec lnc node $W/tools/lanebench.mjs client --url ws://10.231.0.1:18765/ws --clients $PER --lanes 1,2,3 --seconds $SECS --out "$OUT/$name.client.json" > "$OUT/$name.client.log" 2>&1
  wait $sp
  echo "== $name done"
}
rto() { # $1 on|off: the entry's route tweak (rto_min 50ms + quickack) on the server ns's route to the clients
  if [ "$1" = on ]; then ip -n lns route replace 10.231.0.0/30 dev lv-s proto kernel scope link src 10.231.0.1 rto_min 50ms quickack 1
  else ip -n lns route replace 10.231.0.0/30 dev lv-s proto kernel scope link src 10.231.0.1; fi
  echo "route: $(ip -n lns route show 10.231.0.0/30)"
}
ONLY=${ONLY:-all} # or a list: "iid20 burst15 clean"
if [ "$ONLY" = all ]; then
  rto off; SECS_SAVE=$SECS; SECS=30; run clean; SECS=$SECS_SAVE
  run iid10 loss 10%
  run iid20 loss 20%
  run burst15 loss gemodel 5% 25% 90% 0%
  rto on
  run iid20-rto loss 20%
  run burst15-rto loss gemodel 5% 25% 90% 0%
else
  rto off
  for name in $ONLY; do
    case $name in
      iid20) run iid20 loss 20% ;;
      burst15) run burst15 loss gemodel 5% 25% 90% 0% ;;
      clean) run clean ;;
    esac
  done
fi
