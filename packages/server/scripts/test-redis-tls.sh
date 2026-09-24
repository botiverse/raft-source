#!/usr/bin/env bash
# Disposable loopback Redis: requires redis-server (TLS build), openssl, python3.
set -euo pipefail
umask 077
fixture_dir=$(mktemp -d "${TMPDIR:-/tmp}/raft-redis-tls.XXXXXX")
redis_pid=
cleanup() {
  if [[ -n "$redis_pid" ]]; then kill "$redis_pid" 2>/dev/null || true; wait "$redis_pid" 2>/dev/null || true; fi
  rm -rf "$fixture_dir"
}
trap cleanup EXIT
cat > "$fixture_dir/cert.conf" <<'CERT'
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = Raft disposable Redis test
[ext]
subjectAltName = IP:127.0.0.1
basicConstraints = critical,CA:TRUE
CERT
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -config "$fixture_dir/cert.conf" \
  -keyout "$fixture_dir/key.pem" -out "$fixture_dir/cert.pem" > /dev/null 2>&1
fixture_port=$(python3 - <<'PY'
import socket
with socket.socket() as s:
    s.bind(('127.0.0.1', 0))
    print(s.getsockname()[1])
PY
)
cat > "$fixture_dir/redis.conf" <<CONFIG
bind 127.0.0.1
port 0
tls-port $fixture_port
tls-cert-file "$fixture_dir/cert.pem"
tls-key-file "$fixture_dir/key.pem"
tls-ca-cert-file "$fixture_dir/cert.pem"
tls-auth-clients no
requirepass "SyntheticRedisToken!&#\$^<>-123"
save ""
appendonly no
dir "$fixture_dir"
CONFIG
redis-server "$fixture_dir/redis.conf" > "$fixture_dir/redis.log" 2>&1 &
redis_pid=$!
# This checks process/listener readiness; authentication is asserted by the tests.
python3 - "$fixture_port" <<'PY'
import socket,sys,time
for attempt in range(100):
    try:
        with socket.create_connection(('127.0.0.1', int(sys.argv[1])), timeout=.1): break
    except OSError: time.sleep(.02)
else: raise SystemExit('Disposable Redis failed to start; check TLS support in redis-server')
PY
fixture_url="rediss://:SyntheticRedisToken%21%26%23%24%5E%3C%3E-123@127.0.0.1:$fixture_port"
NODE_EXTRA_CA_CERTS="$fixture_dir/cert.pem" RAFT_TEST_REDIS_TLS_URL="$fixture_url" RAFT_TEST_REDIS_URL="$fixture_url" \
  pnpm --filter @botiverse/raft-server test src/redis.tls.test.ts src/socket/accessRevocation.redis.test.ts
