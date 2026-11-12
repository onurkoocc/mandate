#!/bin/bash
# args: TAG MODE PROXY_PORT DECOY_LOOP_PORT NONLOOP_IP DECOY_ANY_PORT NODE OTHER_PROXY_PORT
TAG=$1; MODE=$2; PPORT=$3; DL=$4; NLIP=$5; DA=$6; NODE=$7; OTHER=$8
say() { printf 'PROBE %s\n' "$*"; }
info() { printf 'INFO %s\n' "$*"; }
tcp() { # host port: reached | blocked ...
  local out rc
  out=$(timeout 4 bash -c "exec 3<>/dev/tcp/$1/$2" 2>&1); rc=$?
  if [ $rc -eq 0 ]; then echo "reached"; elif [ $rc -eq 124 ]; then echo "blocked timeout"; else echo "blocked rc=$rc ${out//$'\n'/ }"; fi
}
ntcp() { # same through node, when node exists
  [ -x "$NODE" ] || { echo "n/a (no node)"; return; }
  timeout 8 "$NODE" -e "const s=require('net').connect({host:'$1',port:$2,timeout:4000});s.on('connect',()=>{console.log('reached');process.exit()});s.on('error',e=>{console.log('blocked '+e.code);process.exit()});s.on('timeout',()=>{console.log('blocked timeout');process.exit()})" 2>&1 | head -1
}

info "tools: $(for t in node curl bash timeout getent nslookup dig python3 ip ss nc wget; do if command -v $t >/dev/null 2>&1; then echo -n "$t=yes "; else echo -n "$t=no "; fi; done) node-at-arg=$([ -x "$NODE" ] && echo yes || echo no)"
info "id: $(id | tr '\n' ' ')"
PROXYENV=$(env | grep -i proxy | tr '\n' ' ')
say "env_proxy ${PROXYENV:-none}"
info "env: $(env | grep -v -i proxy | cut -c1-60 | tr '\n' ' ')"
info "resolv.conf: $(cat /etc/resolv.conf 2>&1 | tr '\n' ';')"
info "route: $(cat /proc/net/route 2>&1 | tr '\t' ' ' | tr '\n' ';')"
info "ip addr: $(ip -4 -o addr 2>&1 | tr '\n' ';')"
info "ip6 addr: $(ip -6 -o addr 2>&1 | tr '\n' ';')"
info "listeners (/proc/net/tcp state 0A, hex addr:port): $(awk 'NR>1 && $4=="0A"{print $2}' /proc/net/tcp 2>&1 | tr '\n' ' ')"
info "ifaces: $(cat /proc/net/dev 2>&1 | awk 'NR>2{print $1}' | tr '\n' ' ')"

# Where is the proxy as the sandbox sees it?
PX=${HTTP_PROXY:-${http_proxy:-}}; PX=${PX#http://}; PX=${PX%%/*}
PH=${PX%:*}; PP=${PX##*:}
if [ -z "$PX" ]; then PH=127.0.0.1; PP=$PPORT; fi
export PH PP TAG
say "proxy_address_in_sandbox $PH:$PP (requested 127.0.0.1:$PPORT)"

# b. through the proxy, with no tool that needs to exist: raw HTTP on /dev/tcp
BODY=$(timeout 8 bash -c 'exec 3<>/dev/tcp/$PH/$PP || exit 3; printf "GET http://spike.test/%s HTTP/1.1\r\nHost: spike.test\r\nConnection: close\r\n\r\n" "$TAG" >&3; timeout 5 cat <&3' 2>&1)
if printf '%s' "$BODY" | grep -q "spike-proxy-.*-ok"; then say "proxy_get_raw reached $(printf '%s' "$BODY" | grep -o 'spike-proxy-[^ ]*' | head -1)"; else say "proxy_get_raw blocked ${BODY//$'\n'/ }"; fi
if command -v curl >/dev/null 2>&1; then
  C=$(timeout 9 curl -sS --max-time 6 "http://spike.test/curl-$TAG" 2>&1); rc=$?
  if printf '%s' "$C" | grep -q "spike-proxy-.*-ok"; then say "proxy_get_curl reached $C"; else say "proxy_get_curl blocked rc=$rc ${C//$'\n'/ }"; fi
  C=$(timeout 9 curl -sS --max-time 6 -o /dev/null -w '%{http_code}' "https://spike.test/" 2>&1); rc=$?
  say "proxy_connect $( [ "$C" = 403 ] && echo "reached-proxy-refused-403" || echo "other rc=$rc ${C//$'\n'/ }")"
  C=$(timeout 9 curl -sS --max-time 6 --noproxy '*' "http://spike.test/" 2>&1); rc=$?
  say "noproxy_hostname $( printf '%s' "$C" | grep -q 'spike-proxy' && echo reached || echo "blocked rc=$rc ${C//$'\n'/ }")"
else
  say "proxy_get_curl n/a (no curl)"
fi

# the other proxy (concurrency run) and the decoys
if [ -n "$OTHER" ] && [ "$OTHER" != 0 ]; then
  say "other_proxy_loopback $(tcp 127.0.0.1 $OTHER)"
  say "other_proxy_gateway $(tcp 10.0.2.2 $OTHER)"
fi
if [ "$MODE" = full ]; then
  # c. the other host loopback decoy: 127.0.0.1 inside is the sandbox's own; 10.0.2.2 is where slirp4netns puts the host's loopback
  say "decoy_loopback_own $(tcp 127.0.0.1 $DL)"
  say "decoy_loopback_gateway $(tcp 10.0.2.2 $DL)"
  say "decoy_loopback_gateway_node $(ntcp 10.0.2.2 $DL)"
  say "proxy_port_via_gateway $(tcp 10.0.2.2 $PPORT)"
  # d. the runner's own non-loopback address
  say "decoy_nonloopback $(tcp $NLIP $DA)"
  say "decoy_nonloopback_node $(ntcp $NLIP $DA)"
  # e. external
  say "external_tcp_1_1_1_1_443 $(tcp 1.1.1.1 443)"
  say "external_tcp_1_1_1_1_443_node $(ntcp 1.1.1.1 443)"
  say "external_tcp_1_1_1_1_80 $(tcp 1.1.1.1 80)"
  say "external_tcp_ipv6 $(tcp 2606:4700:4700::1111 443)"
  say "dns_gateway_tcp53 $(tcp 10.0.2.3 53)"
  G=$(timeout 8 getent hosts example.com 2>&1); rc=$?
  if [ $rc -eq 0 ] && [ -n "$G" ]; then say "dns_getent reached $G"; else say "dns_getent blocked rc=$rc ${G//$'\n'/ }"; fi
  if [ -x "$NODE" ]; then
    N=$(timeout 8 "$NODE" -e "require('dns').lookup('example.com',(e,a)=>{console.log(e?'blocked '+e.code:'reached '+a);process.exit()})" 2>&1 | head -1)
    say "dns_node ${N:-blocked (no answer)}"
  fi
  if command -v curl >/dev/null 2>&1; then
    C=$(timeout 9 curl -sS --max-time 6 --noproxy '*' -o /dev/null -w '%{http_code}' https://example.com/ 2>&1); rc=$?
    say "external_https_curl_noproxy $( [ $rc -eq 0 ] && echo "reached $C" || echo "blocked rc=$rc ${C//$'\n'/ }")"
  fi
fi
if [ "$MODE" = hold ]; then sleep 3; fi
exit 0
