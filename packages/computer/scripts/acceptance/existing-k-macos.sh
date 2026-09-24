#!/usr/bin/env bash
set -euo pipefail

readonly CANDIDATE_VERSION="${CANDIDATE_VERSION:?CANDIDATE_VERSION is required}"
readonly BASELINE_VERSION="${BASELINE_VERSION:?BASELINE_VERSION is required}"
readonly HANDS_ALPHA_SHA256="${HANDS_ALPHA_SHA256:?HANDS_ALPHA_SHA256 is required}"
readonly CANDIDATE_MANIFEST_SHA256="${CANDIDATE_MANIFEST_SHA256:?CANDIDATE_MANIFEST_SHA256 is required}"
readonly CANDIDATE_INVENTORY_SHA256="${CANDIDATE_INVENTORY_SHA256:?CANDIDATE_INVENTORY_SHA256 is required}"
readonly STAGING_INSTALLER_SHA256="${STAGING_INSTALLER_SHA256:?STAGING_INSTALLER_SHA256 is required}"
readonly BASELINE_MANIFEST_SHA256="${BASELINE_MANIFEST_SHA256:?BASELINE_MANIFEST_SHA256 is required}"

readonly HANDS_ALPHA_URL='https://hands.build/public/v2/apps/raft-computer-cli/latest?channel=alpha&product_type=cli-binary'
readonly STAGING_ROOT='https://slock-cdn-staging.botiverse.dev/computer/staging'
readonly STAGING_INSTALLER_URL="${STAGING_ROOT}/install.sh"
readonly CANDIDATE_MANIFEST_URL="${STAGING_ROOT}/manifest.json"
readonly CANDIDATE_INVENTORY_URL="${STAGING_ROOT}/${CANDIDATE_VERSION}/candidate-inventory.json"
readonly BASELINE_ROOT='https://cdn.raft.build/computer'
readonly BASELINE_MANIFEST_URL="${BASELINE_ROOT}/${BASELINE_VERSION}/manifest.json"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd -P)"
readonly REPO_ROOT
readonly FIXTURE="${REPO_ROOT}/packages/computer/scripts/acceptance/existing-k-macos-fixture.mjs"
readonly MKTEMP_WRAPPER_DIR="${REPO_ROOT}/packages/computer/scripts/acceptance/bin"
readonly RUN_KEY="${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-1}-$$"
readonly ROOT_LEXICAL="/tmp/raft-existing-k-${RUN_KEY}"
readonly HOME_LEXICAL="${ROOT_LEXICAL}/home"
readonly SLOCK_HOME_LEXICAL="${ROOT_LEXICAL}/state"
readonly INSTALL_DIR="${ROOT_LEXICAL}/bin"
readonly COMPUTER_BINARY="${INSTALL_DIR}/raft-computer"
readonly FIXTURE_STATE="${ROOT_LEXICAL}/fixture-server.json"
readonly FIXTURE_LOG="${ROOT_LEXICAL}/fixture-server.log"
readonly LAUNCHD_LABEL="build.raft.acceptance.existing-k.${GITHUB_RUN_ID:-local}.${GITHUB_RUN_ATTEMPT:-1}"
readonly LAUNCHD_PLIST="${HOME_LEXICAL}/Library/LaunchAgents/${LAUNCHD_LABEL}.plist"
readonly BASELINE_BOOTSTRAP_LOG="${ROOT_LEXICAL}/baseline-launchd-bootstrap.log"
readonly BASELINE_LAUNCHCTL_LOG="${ROOT_LEXICAL}/baseline-launchd-print.log"
readonly BASELINE_PROCESS_LOG="${ROOT_LEXICAL}/baseline-processes.log"
readonly BASELINE_SERVICE_STDOUT="${ROOT_LEXICAL}/baseline-service.stdout.log"
readonly BASELINE_SERVICE_STDERR="${ROOT_LEXICAL}/baseline-service.stderr.log"
readonly BASELINE_LIVE_PROOF_LOG="${ROOT_LEXICAL}/baseline-live-proof.log"

VAR_ROOT_LEXICAL=""
VAR_ROOT_CANONICAL=""
SLOCK_HOME_CANONICAL=""
BASELINE_STABLE_BINARY_CANONICAL=""
FIXTURE_PID=""
SERVER_URL=""
OWNED_PIDS=()

die() {
  printf '::error::%s\n' "$*" >&2
  exit 1
}

sha256_file() {
  shasum -a 256 "$1" | awk '{print $1}'
}

require_sha256() {
  local name=$1 value=$2
  printf '%s' "$value" | LC_ALL=C grep -Eq '^[0-9a-f]{64}$' \
    || die "${name}_INVALID"
}

require_hash() {
  local code=$1 expected=$2 file=$3 actual
  actual=$(sha256_file "$file")
  [ "$actual" = "$expected" ] \
    || die "${code} expected=${expected} actual=${actual}"
}

read_pid_if_present() {
  local file=$1 value
  if [ -f "$file" ]; then
    value=$(tr -d ' \t\r\n' < "$file" 2>/dev/null || true)
    case "$value" in
      ''|*[!0-9]*) ;;
      *) OWNED_PIDS+=("$value") ;;
    esac
  fi
}

pid_alive() {
  kill -0 "$1" 2>/dev/null
}

redact_diagnostic_stream() {
  /usr/bin/sed -E \
    -e 's/sk_[A-Za-z0-9._~+\/-]+/[REDACTED]/g' \
    -e 's/(Bearer )[A-Za-z0-9._~+\/-]+/\1[REDACTED]/g'
}

emit_bounded_diagnostic_file() {
  local kind=$1 file=$2
  printf 'BASELINE_DIAGNOSTIC_BEGIN kind=%s path=%s\n' "$kind" "$file" >&2
  if [ -f "$file" ]; then
    if [ -s "$file" ]; then
      /usr/bin/tail -n 120 "$file" \
        | redact_diagnostic_stream \
        | /usr/bin/cut -c 1-2000 >&2 \
        || true
    else
      printf 'BASELINE_DIAGNOSTIC_FILE_EMPTY kind=%s\n' "$kind" >&2
    fi
  else
    printf 'BASELINE_DIAGNOSTIC_FILE_ABSENT kind=%s\n' "$kind" >&2
  fi
  printf 'BASELINE_DIAGNOSTIC_END kind=%s\n' "$kind" >&2
}

capture_baseline_launchctl_state() {
  launchctl print "gui/$(id -u)/${LAUNCHD_LABEL}" > "$BASELINE_LAUNCHCTL_LOG" 2>&1
}

emit_baseline_diagnostics() {
  local reason=$1 proof_path="${SLOCK_HOME_LEXICAL}/computer/service-version.json"
  capture_baseline_launchctl_state || true
  /bin/ps -axo pid=,ppid=,state=,etime=,command= \
    | /usr/bin/awk -v root="$ROOT_LEXICAL" -v label="$LAUNCHD_LABEL" \
        'index($0, root) > 0 || index($0, label) > 0' \
    > "$BASELINE_PROCESS_LOG" 2>&1 \
    || true
  if [ -e "$proof_path" ]; then
    printf 'BASELINE_PROOF_PATH reason=%s status=present path=%s\n' "$reason" "$proof_path" >&2
  else
    printf 'BASELINE_PROOF_PATH reason=%s status=absent path=%s\n' "$reason" "$proof_path" >&2
  fi
  emit_bounded_diagnostic_file launchctl-bootstrap "$BASELINE_BOOTSTRAP_LOG"
  emit_bounded_diagnostic_file launchctl-state "$BASELINE_LAUNCHCTL_LOG"
  emit_bounded_diagnostic_file owned-processes "$BASELINE_PROCESS_LOG"
  emit_bounded_diagnostic_file service-stdout "$BASELINE_SERVICE_STDOUT"
  emit_bounded_diagnostic_file service-stderr "$BASELINE_SERVICE_STDERR"
  emit_bounded_diagnostic_file live-proof "$BASELINE_LIVE_PROOF_LOG"
}

wait_for_baseline_service_start() {
  local running=0
  for _ in $(seq 1 20); do
    if [ -s "${SLOCK_HOME_LEXICAL}/computer/service-version.json" ]; then
      running=1
      break
    fi
    if ! capture_baseline_launchctl_state; then
      emit_baseline_diagnostics 'BASELINE_LAUNCHD_LABEL_NOT_LOADED'
      die 'BASELINE_LAUNCHD_LABEL_NOT_LOADED'
    fi
    if /usr/bin/grep -Eq '^[[:space:]]*state = running$' "$BASELINE_LAUNCHCTL_LOG"; then
      running=1
      break
    fi
    sleep 0.25
  done
  if [ "$running" -ne 1 ]; then
    emit_baseline_diagnostics 'BASELINE_SERVICE_EXITED_EARLY'
    die 'BASELINE_SERVICE_EXITED_EARLY'
  fi
}

cleanup() {
  local original_status=$? processes_ok=1 label_ok=1 files_ok=1 pid
  trap - EXIT INT TERM
  set +e

  if [ -x "$COMPUTER_BINARY" ]; then
    SLOCK_HOME="${SLOCK_HOME_CANONICAL:-$SLOCK_HOME_LEXICAL}" \
      RAFT_HOME="${SLOCK_HOME_CANONICAL:-$SLOCK_HOME_LEXICAL}" \
      "$COMPUTER_BINARY" stop >/dev/null 2>&1
  fi
  read_pid_if_present "${SLOCK_HOME_LEXICAL}/computer/run/service.pid"
  for server_id in \
    11111111-1111-4111-8111-111111111111 \
    22222222-2222-4222-8222-222222222222 \
    33333333-3333-4333-8333-333333333333; do
    read_pid_if_present "${SLOCK_HOME_LEXICAL}/computer/servers/${server_id}/runner.pid"
  done
  if [ -n "$FIXTURE_PID" ]; then OWNED_PIDS+=("$FIXTURE_PID"); fi

  launchctl bootout "gui/$(id -u)/${LAUNCHD_LABEL}" >/dev/null 2>&1
  for pid in "${OWNED_PIDS[@]}"; do
    if pid_alive "$pid"; then kill -TERM "$pid" >/dev/null 2>&1; fi
  done
  for _ in $(seq 1 80); do
    local any_alive=0
    for pid in "${OWNED_PIDS[@]}"; do
      if pid_alive "$pid"; then any_alive=1; fi
    done
    [ "$any_alive" -eq 0 ] && break
    sleep 0.25
  done
  for pid in "${OWNED_PIDS[@]}"; do
    if pid_alive "$pid"; then
      kill -KILL "$pid" >/dev/null 2>&1
      sleep 0.1
    fi
  done

  rm -rf "$ROOT_LEXICAL"
  if [ -n "$VAR_ROOT_LEXICAL" ]; then rm -rf "$VAR_ROOT_LEXICAL"; fi

  if launchctl print "gui/$(id -u)/${LAUNCHD_LABEL}" >/dev/null 2>&1; then label_ok=0; fi
  for pid in "${OWNED_PIDS[@]}"; do
    if pid_alive "$pid"; then processes_ok=0; fi
  done
  if [ -e "$ROOT_LEXICAL" ] || { [ -n "$VAR_ROOT_LEXICAL" ] && [ -e "$VAR_ROOT_LEXICAL" ]; }; then
    files_ok=0
  fi
  printf 'CLEANUP_RECEIPT {"label":"%s","ownedProcessCount":%s,"zeroOwnedProcesses":%s,"zeroOwnedLabels":%s,"zeroOwnedFiles":%s}\n' \
    "$LAUNCHD_LABEL" "${#OWNED_PIDS[@]}" \
    "$([ "$processes_ok" -eq 1 ] && printf true || printf false)" \
    "$([ "$label_ok" -eq 1 ] && printf true || printf false)" \
    "$([ "$files_ok" -eq 1 ] && printf true || printf false)"

  if [ "$processes_ok" -ne 1 ] || [ "$label_ok" -ne 1 ] || [ "$files_ok" -ne 1 ]; then exit 1; fi
  exit "$original_status"
}
trap cleanup EXIT INT TERM

[ "$(uname -s)" = "Darwin" ] || die 'DISPOSABLE_MACOS_REQUIRED'
[ "$CANDIDATE_VERSION" = '1.0.22' ] || die 'CANDIDATE_VERSION_MUST_EQUAL_1.0.22'
[ "$BASELINE_VERSION" = '1.0.17' ] || die 'BASELINE_VERSION_MUST_EQUAL_1.0.17'
for binding in \
  "HANDS_ALPHA_SHA256:$HANDS_ALPHA_SHA256" \
  "CANDIDATE_MANIFEST_SHA256:$CANDIDATE_MANIFEST_SHA256" \
  "CANDIDATE_INVENTORY_SHA256:$CANDIDATE_INVENTORY_SHA256" \
  "STAGING_INSTALLER_SHA256:$STAGING_INSTALLER_SHA256" \
  "BASELINE_MANIFEST_SHA256:$BASELINE_MANIFEST_SHA256"; do
  require_sha256 "${binding%%:*}" "${binding#*:}"
done

case "${TMPDIR:-}" in
  /var/folders/*) ;;
  *) die "MACOS_NATIVE_TMPDIR_REQUIRED actual=${TMPDIR:-unset}" ;;
esac
VAR_ROOT_LEXICAL=$(/usr/bin/mktemp -d "${TMPDIR%/}/raft-existing-k.XXXXXX")
VAR_ROOT_CANONICAL=$(/usr/bin/python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$VAR_ROOT_LEXICAL")
case "$VAR_ROOT_CANONICAL" in
  /private/var/folders/*) ;;
  *) die "VAR_FOLDER_CANONICAL_IDENTITY_MISMATCH lexical=${VAR_ROOT_LEXICAL} canonical=${VAR_ROOT_CANONICAL}" ;;
esac
mkdir -p "$ROOT_LEXICAL" "${VAR_ROOT_LEXICAL}/preflight"

readonly PREFLIGHT="${VAR_ROOT_LEXICAL}/preflight"
curl -fsSL "$HANDS_ALPHA_URL" -o "${PREFLIGHT}/hands-alpha.json" \
  || die 'HANDS_ALPHA_PREFLIGHT_UNAVAILABLE'
curl -fsSL "$CANDIDATE_MANIFEST_URL" -o "${PREFLIGHT}/candidate-manifest.json" \
  || die 'CANDIDATE_MANIFEST_PREFLIGHT_UNAVAILABLE'
curl -fsSL "$CANDIDATE_INVENTORY_URL" -o "${PREFLIGHT}/candidate-inventory.json" \
  || die 'CANDIDATE_INVENTORY_PREFLIGHT_UNAVAILABLE'
curl -fsSL "$STAGING_INSTALLER_URL" -o "${PREFLIGHT}/install.sh" \
  || die 'STAGING_INSTALLER_PREFLIGHT_UNAVAILABLE'
curl -fsSL "$BASELINE_MANIFEST_URL" -o "${PREFLIGHT}/baseline-manifest.json" \
  || die 'BASELINE_MANIFEST_PREFLIGHT_UNAVAILABLE'

require_hash HANDS_ALPHA_HASH_MISMATCH "$HANDS_ALPHA_SHA256" "${PREFLIGHT}/hands-alpha.json"
require_hash CANDIDATE_MANIFEST_HASH_MISMATCH "$CANDIDATE_MANIFEST_SHA256" "${PREFLIGHT}/candidate-manifest.json"
require_hash CANDIDATE_INVENTORY_HASH_MISMATCH "$CANDIDATE_INVENTORY_SHA256" "${PREFLIGHT}/candidate-inventory.json"
require_hash STAGING_INSTALLER_HASH_MISMATCH "$STAGING_INSTALLER_SHA256" "${PREFLIGHT}/install.sh"
require_hash BASELINE_MANIFEST_HASH_MISMATCH "$BASELINE_MANIFEST_SHA256" "${PREFLIGHT}/baseline-manifest.json"

case "$(uname -m)" in
  arm64) PLATFORM_KEY='darwin-arm64' ;;
  x86_64) PLATFORM_KEY='darwin-x64' ;;
  *) die "UNSUPPORTED_MACOS_ARCH arch=$(uname -m)" ;;
esac
export PLATFORM_KEY

eval "$(/usr/bin/python3 - \
  "${PREFLIGHT}/hands-alpha.json" \
  "${PREFLIGHT}/candidate-manifest.json" \
  "${PREFLIGHT}/candidate-inventory.json" \
  "${PREFLIGHT}/baseline-manifest.json" \
  "$CANDIDATE_VERSION" "$BASELINE_VERSION" "$PLATFORM_KEY" "$CANDIDATE_MANIFEST_SHA256" <<'PY'
import json, shlex, sys
hands_path, candidate_path, inventory_path, baseline_path, candidate_version, baseline_version, platform_key, candidate_manifest_sha256 = sys.argv[1:]
hands = json.load(open(hands_path, encoding="utf-8"))
candidate = json.load(open(candidate_path, encoding="utf-8"))
inventory = json.load(open(inventory_path, encoding="utf-8"))
baseline = json.load(open(baseline_path, encoding="utf-8"))
if hands.get("build", {}).get("version") != candidate_version:
    raise SystemExit("HANDS_ALPHA_VERSION_MISMATCH")
if candidate.get("version") != candidate_version:
    raise SystemExit("CANDIDATE_MANIFEST_VERSION_MISMATCH")
if baseline.get("version") != baseline_version:
    raise SystemExit("BASELINE_MANIFEST_VERSION_MISMATCH")
candidate_target = candidate.get("targets", {}).get(platform_key)
baseline_target = baseline.get("targets", {}).get(platform_key)
if not candidate_target or not baseline_target:
    raise SystemExit("PUBLIC_MANIFEST_TARGET_MISSING")
entries = {entry.get("file"): entry for entry in inventory if isinstance(entry, dict)}
for file_name in ("manifest.json", candidate_target.get("file"), candidate_target.get("gz", {}).get("file")):
    if not file_name or file_name not in entries:
        raise SystemExit(f"CANDIDATE_INVENTORY_ENTRY_MISSING:{file_name}")
if entries["manifest.json"].get("sha256") != candidate_manifest_sha256:
    raise SystemExit("CANDIDATE_INVENTORY_MANIFEST_IDENTITY_MISMATCH")
for artifact in (candidate_target, candidate_target.get("gz", {})):
    entry = entries[artifact["file"]]
    if entry.get("sha256") != artifact.get("sha256") or entry.get("sizeBytes") != artifact.get("size"):
        raise SystemExit(f"CANDIDATE_INVENTORY_ARTIFACT_IDENTITY_MISMATCH:{artifact['file']}")
hands_targets = hands.get("assets", [])
hands_target = next((entry for entry in hands_targets if entry.get("platform") + "-" + entry.get("arch") == platform_key), None)
if not hands_target:
    raise SystemExit("HANDS_ALPHA_TARGET_MISSING")
if hands_target.get("sha256") != candidate_target.get("sha256") or hands_target.get("size_bytes") != candidate_target.get("size"):
    raise SystemExit("HANDS_ALPHA_TARGET_IDENTITY_MISMATCH")
values = {
    "CANDIDATE_ARTIFACT_FILE": candidate_target["file"],
    "CANDIDATE_ARTIFACT_SHA256": candidate_target["sha256"],
    "CANDIDATE_ARTIFACT_SIZE": str(candidate_target["size"]),
    "CANDIDATE_GZIP_FILE": candidate_target.get("gz", {}).get("file", ""),
    "CANDIDATE_GZIP_SHA256": candidate_target.get("gz", {}).get("sha256", ""),
    "BASELINE_ARTIFACT_FILE": baseline_target["file"],
    "BASELINE_ARTIFACT_SHA256": baseline_target["sha256"],
    "BASELINE_ARTIFACT_SIZE": str(baseline_target["size"]),
    "BASELINE_GZIP_FILE": baseline_target.get("gz", {}).get("file", ""),
    "BASELINE_GZIP_SHA256": baseline_target.get("gz", {}).get("sha256", ""),
}
for key, value in values.items():
    print(f"{key}={shlex.quote(value)}")
PY
)"
export CANDIDATE_ARTIFACT_SHA256 BASELINE_ARTIFACT_SHA256

if [ -n "$CANDIDATE_GZIP_FILE" ] && [ -n "$CANDIDATE_GZIP_SHA256" ]; then
  curl -fsSL "${STAGING_ROOT}/${CANDIDATE_VERSION}/${CANDIDATE_GZIP_FILE}" -o "${PREFLIGHT}/candidate.gz" \
    || die 'CANDIDATE_PUBLIC_BYTES_UNAVAILABLE'
  require_hash CANDIDATE_GZIP_HASH_MISMATCH "$CANDIDATE_GZIP_SHA256" "${PREFLIGHT}/candidate.gz"
  gzip -dc "${PREFLIGHT}/candidate.gz" > "${PREFLIGHT}/candidate-artifact"
else
  curl -fsSL "${STAGING_ROOT}/${CANDIDATE_VERSION}/${CANDIDATE_ARTIFACT_FILE}" -o "${PREFLIGHT}/candidate-artifact" \
    || die 'CANDIDATE_PUBLIC_BYTES_UNAVAILABLE'
fi
require_hash CANDIDATE_PUBLIC_BYTES_HASH_MISMATCH "$CANDIDATE_ARTIFACT_SHA256" "${PREFLIGHT}/candidate-artifact"
[ "$(wc -c < "${PREFLIGHT}/candidate-artifact" | tr -d ' ')" = "$CANDIDATE_ARTIFACT_SIZE" ] \
  || die 'CANDIDATE_PUBLIC_BYTES_SIZE_MISMATCH'

if [ -n "$BASELINE_GZIP_FILE" ] && [ -n "$BASELINE_GZIP_SHA256" ]; then
  curl -fsSL "${BASELINE_ROOT}/${BASELINE_VERSION}/${BASELINE_GZIP_FILE}" -o "${PREFLIGHT}/baseline.gz" \
    || die 'BASELINE_PUBLIC_BYTES_UNAVAILABLE'
  require_hash BASELINE_GZIP_HASH_MISMATCH "$BASELINE_GZIP_SHA256" "${PREFLIGHT}/baseline.gz"
  gzip -dc "${PREFLIGHT}/baseline.gz" > "${PREFLIGHT}/baseline-artifact"
else
  curl -fsSL "${BASELINE_ROOT}/${BASELINE_VERSION}/${BASELINE_ARTIFACT_FILE}" -o "${PREFLIGHT}/baseline-artifact" \
    || die 'BASELINE_PUBLIC_BYTES_UNAVAILABLE'
fi
require_hash BASELINE_PUBLIC_BYTES_HASH_MISMATCH "$BASELINE_ARTIFACT_SHA256" "${PREFLIGHT}/baseline-artifact"
[ "$(wc -c < "${PREFLIGHT}/baseline-artifact" | tr -d ' ')" = "$BASELINE_ARTIFACT_SIZE" ] \
  || die 'BASELINE_PUBLIC_BYTES_SIZE_MISMATCH'
printf 'PREFLIGHT_RECEIPT candidate=%s baseline=%s platform=%s hands=%s manifest=%s inventory=%s installer=%s baseline_manifest=%s baseline_bytes=%s\n' \
  "$CANDIDATE_VERSION" "$BASELINE_VERSION" "$PLATFORM_KEY" "$HANDS_ALPHA_SHA256" \
  "$CANDIDATE_MANIFEST_SHA256" "$CANDIDATE_INVENTORY_SHA256" "$STAGING_INSTALLER_SHA256" \
  "$BASELINE_MANIFEST_SHA256" "$BASELINE_ARTIFACT_SHA256"

mkdir -p "$HOME_LEXICAL" "$SLOCK_HOME_LEXICAL" "$INSTALL_DIR"
SLOCK_HOME_CANONICAL=$(/usr/bin/python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$SLOCK_HOME_LEXICAL")
case "$SLOCK_HOME_CANONICAL" in
  /private/tmp/*) ;;
  *) die "BASELINE_CANONICAL_HOME_MISMATCH lexical=${SLOCK_HOME_LEXICAL} canonical=${SLOCK_HOME_CANONICAL}" ;;
esac
export HOME="$HOME_LEXICAL"
export SLOCK_HOME="$SLOCK_HOME_CANONICAL"
export RAFT_HOME="$SLOCK_HOME_CANONICAL"
export RAFT_COMPUTER_INSTALL_DIR="$INSTALL_DIR"
export RAFT_COMPUTER_NO_MODIFY_PATH=1
export NO_PROXY='127.0.0.1,localhost'
export no_proxy="$NO_PROXY"

node "$FIXTURE" serve --state-file "$FIXTURE_STATE" > "$FIXTURE_LOG" 2>&1 &
FIXTURE_PID=$!
for _ in $(seq 1 80); do
  [ -s "$FIXTURE_STATE" ] && break
  pid_alive "$FIXTURE_PID" || die 'FIXTURE_SERVER_EXITED'
  sleep 0.25
done
[ -s "$FIXTURE_STATE" ] || die 'FIXTURE_SERVER_START_TIMEOUT'
SERVER_URL=$(/usr/bin/python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["serverUrl"])' "$FIXTURE_STATE")

curl -fsSL "$STAGING_INSTALLER_URL" \
  | RAFT_COMPUTER_VERSION="$BASELINE_VERSION" \
    RAFT_COMPUTER_INSTALL_CHANNEL="pinned:${BASELINE_VERSION}" \
    RAFT_COMPUTER_RELEASE_BASE="$BASELINE_ROOT" \
    sh
[ -x "$COMPUTER_BINARY" ] || die 'BASELINE_DISPATCHER_MISSING'
[ "$(sha256_file "$COMPUTER_BINARY")" = "$BASELINE_ARTIFACT_SHA256" ] \
  || die 'BASELINE_DISPATCHER_BYTES_MISMATCH'
node "$FIXTURE" materialize-legacy-k-stable \
  --slock-home "$SLOCK_HOME_LEXICAL" \
  --version "$BASELINE_VERSION" \
  --artifact "$COMPUTER_BINARY" \
  --artifact-sha256 "$BASELINE_ARTIFACT_SHA256"
BASELINE_STABLE_BINARY_CANONICAL=$(/usr/bin/python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' \
  "${SLOCK_HOME_LEXICAL}/computer/k/slots/stable/artifact.bin")
node "$FIXTURE" assert-legacy-k-launch-identity \
  --source-slock-home "$SLOCK_HOME_LEXICAL" \
  --launch-slock-home "$SLOCK_HOME_CANONICAL" \
  --binary "$BASELINE_STABLE_BINARY_CANONICAL"

node "$FIXTURE" seed --slock-home "$SLOCK_HOME_LEXICAL" --server-url "$SERVER_URL"
mkdir -p "$(dirname "$LAUNCHD_PLIST")"
/usr/bin/python3 - "$LAUNCHD_PLIST" "$LAUNCHD_LABEL" "$SLOCK_HOME_CANONICAL" \
  "$BASELINE_STABLE_BINARY_CANONICAL" "$HOME_LEXICAL" \
  "${SERVER_URL}/failure" "$BASELINE_SERVICE_STDOUT" "$BASELINE_SERVICE_STDERR" <<'PY'
import plistlib, sys
path, label, slock_home, binary, home, failure_base, service_stdout, service_stderr = sys.argv[1:]
payload = {
    "Label": label,
    # Computer 1.0.17 already retires the historical manager grammar
    # `__service --slock-home ... --os-supervised launchd-user` before the CLI
    # graph loads. Keep launchd as the real disposable process owner, but carry
    # the supervised shell-environment seam through the protected env marker.
    "ProgramArguments": [
        binary,
        "__service",
        "--slock-home",
        slock_home,
    ],
    "EnvironmentVariables": {
        "HOME": home,
        "SLOCK_HOME": slock_home,
        "RAFT_HOME": slock_home,
        "RAFT_COMPUTER_OS_SUPERVISOR_KIND": "launchd-user",
        "NO_PROXY": "127.0.0.1,localhost",
        "no_proxy": "127.0.0.1,localhost",
        "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
        "RAFT_COMPUTER_RELEASE_BACKEND": "legacy-cdn",
        "RAFT_COMPUTER_UPGRADE_BASE_URL": failure_base,
    },
    "RunAtLoad": True,
    "KeepAlive": False,
    "ProcessType": "Background",
    "StandardOutPath": service_stdout,
    "StandardErrorPath": service_stderr,
}
with open(path, "wb") as stream:
    plistlib.dump(payload, stream, sort_keys=True)
PY
if ! launchctl bootstrap "gui/$(id -u)" "$LAUNCHD_PLIST" > "$BASELINE_BOOTSTRAP_LOG" 2>&1; then
  emit_baseline_diagnostics 'BASELINE_LAUNCHD_BOOTSTRAP_FAILED'
  die 'BASELINE_LAUNCHD_BOOTSTRAP_FAILED'
fi
wait_for_baseline_service_start
if ! node "$FIXTURE" assert-live --slock-home "$SLOCK_HOME_LEXICAL" \
  --version "$BASELINE_VERSION" --server-url "$SERVER_URL" \
  > "$BASELINE_LIVE_PROOF_LOG" 2>&1; then
  emit_baseline_diagnostics 'BASELINE_LIVE_PROOF_FAILED'
  die 'BASELINE_LIVE_PROOF_FAILED'
fi
emit_bounded_diagnostic_file live-proof "$BASELINE_LIVE_PROOF_LOG"
PRE_SERVICE_PID=$(tr -d ' \t\r\n' < "${SLOCK_HOME_LEXICAL}/computer/run/service.pid")

"$COMPUTER_BINARY" upgrade --target-version 1.0.18 \
  > "${ROOT_LEXICAL}/expected-failed-k.log" 2>&1 \
  || die 'FAILED_K_SERVICE_REQUEST_REJECTED'
grep -F 'Upgrade to 1.0.18 started' "${ROOT_LEXICAL}/expected-failed-k.log" >/dev/null \
  || die 'FAILED_K_SERVICE_PATH_NOT_USED'
node "$FIXTURE" assert-failed-receipt --slock-home "$SLOCK_HOME_LEXICAL"
node "$FIXTURE" assert-live --slock-home "$SLOCK_HOME_LEXICAL" --version "$BASELINE_VERSION" --server-url "$SERVER_URL"
printf 'PRESTATE_RECEIPT label=%s resident_pid=%s stable=%s channel=%s attachments=3 failed_k=1.0.17_to_1.0.18\n' \
  "$LAUNCHD_LABEL" "$PRE_SERVICE_PID" \
  "$(tr -d ' \t\r\n' < "${SLOCK_HOME_LEXICAL}/computer/k/slots/stable/VERSION")" \
  "$(tr -d ' \t\r\n' < "${SLOCK_HOME_LEXICAL}/computer/channel")"

install_candidate() {
  local phase=$1
  local mktemp_log="${ROOT_LEXICAL}/mktemp-${phase}.tsv"
  local installer_log="${ROOT_LEXICAL}/installer-${phase}.log" installer_status
  set +e
  curl -fsSL https://slock-cdn-staging.botiverse.dev/computer/staging/install.sh \
    | TMPDIR="$VAR_ROOT_LEXICAL" \
      PATH="${MKTEMP_WRAPPER_DIR}:/usr/bin:/bin:/usr/sbin:/sbin" \
      RAFT_ACCEPTANCE_MKTEMP_LOG="$mktemp_log" \
      RAFT_COMPUTER_VERSION=1.0.22 \
      RAFT_COMPUTER_INSTALL_CHANNEL=pinned:1.0.22 \
      RAFT_COMPUTER_RELEASE_BASE="$STAGING_ROOT" \
      RAFT_COMPUTER_INSTALL_DIR="$INSTALL_DIR" \
      RAFT_COMPUTER_NO_MODIFY_PATH=1 \
      SLOCK_HOME="$SLOCK_HOME_LEXICAL" \
      RAFT_HOME="$SLOCK_HOME_LEXICAL" \
      HOME="$HOME_LEXICAL" \
      sh > "$installer_log" 2>&1
  installer_status=$?
  set -e
  if [ "$installer_status" -ne 0 ]; then
    if grep -Eq 'UPGRADE_ALREADY_RUNNING|K_UPGRADE_OPERATION_BLOCKED|OPERATION_RECEIPT_PENDING' "$installer_log"; then
      sed -n '1,120p' "$installer_log" >&2
      die "EXISTING_UNACKNOWLEDGED_K_BLOCKED phase=${phase}"
    fi
    sed -n '1,120p' "$installer_log" >&2
    die "CANDIDATE_INSTALL_FAILED phase=${phase} status=${installer_status}"
  fi
  [ -s "$mktemp_log" ] || die "CANDIDATE_TMP_IDENTITY_MISSING phase=${phase}"
  while IFS=$'\t' read -r lexical canonical; do
    case "$lexical" in "${VAR_ROOT_LEXICAL}"/*) ;; *) die "CANDIDATE_TMP_LEXICAL_MISMATCH phase=${phase} path=${lexical}" ;; esac
    case "$canonical" in "${VAR_ROOT_CANONICAL}"/*) ;; *) die "CANDIDATE_TMP_CANONICAL_MISMATCH phase=${phase} path=${canonical}" ;; esac
    printf 'CANDIDATE_TMP_IDENTITY phase=%s lexical=%s canonical=%s\n' "$phase" "$lexical" "$canonical"
  done < "$mktemp_log"
}

assert_bytes_and_k() {
  local version=$1 expected_sha=$2
  local stable="${SLOCK_HOME_LEXICAL}/computer/k/slots/stable/artifact.bin"
  [ "$(sha256_file "$COMPUTER_BINARY")" = "$expected_sha" ] \
    || die "DISPATCHER_BYTES_MISMATCH version=${version}"
  [ "$(sha256_file "$stable")" = "$expected_sha" ] \
    || die "K_STABLE_BYTES_MISMATCH version=${version}"
  [ "$(tr -d ' \t\r\n' < "${SLOCK_HOME_LEXICAL}/computer/k/slots/stable/VERSION")" = "$version" ] \
    || die "K_STABLE_VERSION_MISMATCH version=${version}"
  [ ! -e "${SLOCK_HOME_LEXICAL}/computer/k/slots/experiment" ] \
    || die "K_EXPERIMENT_NOT_ABSENT version=${version}"
  [ "$(tr -d ' \t\r\n' < "${SLOCK_HOME_LEXICAL}/computer/channel")" = "pinned:${version}" ] \
    || die "SAVED_CHANNEL_MISMATCH version=${version}"
  node "$FIXTURE" assert-live --slock-home "$SLOCK_HOME_LEXICAL" --version "$version" --server-url "$SERVER_URL"
}

install_candidate first
node "$FIXTURE" assert-operation --slock-home "$SLOCK_HOME_LEXICAL" \
  --from "$BASELINE_VERSION" --target "$CANDIDATE_VERSION" --outcome promoted \
  --carrier installer --artifact-sha256 "$CANDIDATE_ARTIFACT_SHA256"
assert_bytes_and_k "$CANDIDATE_VERSION" "$CANDIDATE_ARTIFACT_SHA256"

K_ROOT_LEXICAL="${SLOCK_HOME_LEXICAL}/computer/k"
K_ROOT_CANONICAL=$(/usr/bin/python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$K_ROOT_LEXICAL")
case "$K_ROOT_LEXICAL" in /tmp/*) ;; *) die "K_ROOT_LEXICAL_MISMATCH path=${K_ROOT_LEXICAL}" ;; esac
case "$K_ROOT_CANONICAL" in /private/tmp/*) ;; *) die "K_ROOT_CANONICAL_MISMATCH path=${K_ROOT_CANONICAL}" ;; esac
printf 'K_ROOT_IDENTITY lexical=%s canonical=%s\n' "$K_ROOT_LEXICAL" "$K_ROOT_CANONICAL"

FOREIGN_ARG="${ROOT_LEXICAL}/foreign-absolute-argv"
/usr/bin/touch "$FOREIGN_ARG"
set +e
"$COMPUTER_BINARY" "$FOREIGN_ARG" status > "${ROOT_LEXICAL}/foreign-argv.log" 2>&1
foreign_status=$?
set -e
[ "$foreign_status" -ne 0 ] || die 'FOREIGN_ARGV_WAS_SWALLOWED'
grep -F "$FOREIGN_ARG" "${ROOT_LEXICAL}/foreign-argv.log" >/dev/null \
  || die 'FOREIGN_ARGV_NOT_VISIBLE'
node "$FIXTURE" probe-missing-self --binary "$COMPUTER_BINARY" \
  --copy "${VAR_ROOT_LEXICAL}/missing-self-raft-computer" \
  --slock-home "$SLOCK_HOME_LEXICAL"

"$COMPUTER_BINARY" restart
node "$FIXTURE" assert-live --slock-home "$SLOCK_HOME_LEXICAL" --version "$CANDIDATE_VERSION" --server-url "$SERVER_URL"
printf 'RESTART_RECEIPT version=%s attachments=3\n' "$CANDIDATE_VERSION"

curl -fsSL "$STAGING_INSTALLER_URL" \
  | RAFT_COMPUTER_VERSION="$BASELINE_VERSION" \
    RAFT_COMPUTER_INSTALL_CHANNEL="pinned:${BASELINE_VERSION}" \
    RAFT_COMPUTER_RELEASE_BASE="$BASELINE_ROOT" \
    RAFT_COMPUTER_INSTALL_DIR="$INSTALL_DIR" \
    RAFT_COMPUTER_NO_MODIFY_PATH=1 \
    RAFT_COMPUTER_FORCE=1 \
    SLOCK_HOME="$SLOCK_HOME_LEXICAL" \
    RAFT_HOME="$SLOCK_HOME_LEXICAL" \
    HOME="$HOME_LEXICAL" \
    sh
node "$FIXTURE" assert-operation --slock-home "$SLOCK_HOME_LEXICAL" \
  --from "$CANDIDATE_VERSION" --target "$BASELINE_VERSION" --outcome promoted \
  --carrier installer --artifact-sha256 "$BASELINE_ARTIFACT_SHA256"
assert_bytes_and_k "$BASELINE_VERSION" "$BASELINE_ARTIFACT_SHA256"
printf 'ROLLBACK_RECEIPT from=%s target=%s terminal=promoted direction=forced-downgrade attachments=3\n' \
  "$CANDIDATE_VERSION" "$BASELINE_VERSION"

install_candidate final
node "$FIXTURE" assert-operation --slock-home "$SLOCK_HOME_LEXICAL" \
  --from "$BASELINE_VERSION" --target "$CANDIDATE_VERSION" --outcome promoted \
  --carrier installer --artifact-sha256 "$CANDIDATE_ARTIFACT_SHA256"
assert_bytes_and_k "$CANDIDATE_VERSION" "$CANDIDATE_ARTIFACT_SHA256"
"$COMPUTER_BINARY" restart
node "$FIXTURE" assert-live --slock-home "$SLOCK_HOME_LEXICAL" --version "$CANDIDATE_VERSION" --server-url "$SERVER_URL"
printf 'FINAL_ACCEPTANCE_RECEIPT version=%s dispatcher_sha256=%s stable_sha256=%s channel=pinned:%s attachments=3 restart=passed rollback_reupgrade=passed\n' \
  "$CANDIDATE_VERSION" "$CANDIDATE_ARTIFACT_SHA256" "$CANDIDATE_ARTIFACT_SHA256" "$CANDIDATE_VERSION"
