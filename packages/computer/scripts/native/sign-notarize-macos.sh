#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: $0 --dir <dist-dir> --version <semver>" >&2
  exit 2
}

DIST_DIR=""
VERSION=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --dir)
      [ "$#" -ge 2 ] || usage
      DIST_DIR="$2"
      shift 2
      ;;
    --version)
      [ "$#" -ge 2 ] || usage
      VERSION="$2"
      shift 2
      ;;
    *) usage ;;
  esac
done

[ -n "$DIST_DIR" ] && [ -n "$VERSION" ] || usage
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
  echo "::error::Version must be a plain semver" >&2
  exit 1
}
[ "$(uname -s)" = "Darwin" ] || {
  echo "::error::macOS signing must run on Darwin" >&2
  exit 1
}

for name in \
  MACOS_CERT_P12_BASE64 \
  MACOS_CERT_PASSWORD \
  APPLE_TEAM_ID \
  APPLE_API_ISSUER_ID \
  APPLE_API_KEY_ID \
  APPLE_API_PRIVATE_KEY
do
  if [ -z "${!name:-}" ]; then
    echo "::error::Missing ${name}" >&2
    exit 1
  fi
done

for command_name in base64 codesign ditto gzip jq security shasum uuidgen xcrun; do
  command -v "$command_name" >/dev/null 2>&1 || {
    echo "::error::Missing required command: ${command_name}" >&2
    exit 1
  }
done

DIST_DIR="$(cd "$DIST_DIR" && pwd)"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENTITLEMENTS_PATH="${SCRIPT_DIR}/entitlements.mac.plist"
RUNNER_TEMP="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
KEYCHAIN_PATH="${RUNNER_TEMP}/raft-computer-cli-release.keychain-db"
KEYCHAIN_PASSWORD="$(uuidgen)"
CERT_PATH="${RUNNER_TEMP}/raft-computer-cli-developer-id.p12"
NOTARY_KEY_PATH="${RUNNER_TEMP}/AuthKey_${APPLE_API_KEY_ID}.p8"

cleanup() {
  set +e
  if [ -e "$KEYCHAIN_PATH" ]; then
    security delete-keychain "$KEYCHAIN_PATH" >/dev/null 2>&1
  fi
  rm -f "$CERT_PATH" "$NOTARY_KEY_PATH"
}
trap cleanup EXIT

umask 077
if ! printf '%s' "$MACOS_CERT_P12_BASE64" \
  | tr -d '[:space:]' \
  | base64 --decode > "$CERT_PATH" 2>/dev/null \
  || [ ! -s "$CERT_PATH" ]; then
  echo "::error::MACOS_CERT_P12_BASE64 is not a valid non-empty base64-encoded p12" >&2
  exit 1
fi
unset MACOS_CERT_P12_BASE64
chmod 600 "$CERT_PATH"

security create-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN_PATH"
security set-keychain-settings -lut 21600 "$KEYCHAIN_PATH"
security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN_PATH"
security import "$CERT_PATH" \
  -P "$MACOS_CERT_PASSWORD" \
  -A \
  -t cert \
  -f pkcs12 \
  -k "$KEYCHAIN_PATH"
unset MACOS_CERT_PASSWORD
security list-keychain -d user -s "$KEYCHAIN_PATH" login.keychain-db
security set-key-partition-list \
  -S apple-tool:,apple:,codesign: \
  -s \
  -k "$KEYCHAIN_PASSWORD" \
  "$KEYCHAIN_PATH"

IDENTITY_LINE="$(security find-identity -v -p codesigning "$KEYCHAIN_PATH" \
  | grep 'Developer ID Application' \
  | head -n 1 || true)"
if [ -z "$IDENTITY_LINE" ] || [[ "$IDENTITY_LINE" != *"(${APPLE_TEAM_ID})"* ]]; then
  echo "::error::Imported p12 has no Developer ID Application identity for APPLE_TEAM_ID" >&2
  exit 1
fi
IDENTITY_SHA="$(printf '%s\n' "$IDENTITY_LINE" | awk '{print $2}')"
[[ "$IDENTITY_SHA" =~ ^[0-9A-Fa-f]{40}$ ]] || {
  echo "::error::Could not resolve the Developer ID identity fingerprint" >&2
  exit 1
}

printf '%s' "$APPLE_API_PRIVATE_KEY" > "$NOTARY_KEY_PATH"
unset APPLE_API_PRIVATE_KEY
chmod 600 "$NOTARY_KEY_PATH"

binaries=(
  "$DIST_DIR/raft-computer-darwin-arm64"
  "$DIST_DIR/raft-computer-darwin-x64"
)
for binary in "${binaries[@]}"; do
  [ -f "$binary" ] || {
    echo "::error::Missing expected macOS binary: ${binary}" >&2
    exit 1
  }
done

for binary in "${binaries[@]}"; do
  file_name="$(basename "$binary")"
  target="${file_name#raft-computer-}"
  archive="${binary}.notarization.zip"
  submit_json="${binary}.notarization.json"
  log_json="${binary}.notarization.log.json"
  receipt_json="${binary}.notarization.receipt.json"

  codesign --remove-signature "$binary" 2>/dev/null || true
  codesign \
    --force \
    --sign "$IDENTITY_SHA" \
    --keychain "$KEYCHAIN_PATH" \
    --options runtime \
    --timestamp \
    --entitlements "$ENTITLEMENTS_PATH" \
    "$binary"
  codesign --verify --strict --verbose=2 "$binary"

  SIGNATURE_DETAILS="$(codesign -dv --verbose=4 "$binary" 2>&1)"
  printf '%s\n' "$SIGNATURE_DETAILS" | grep -F 'Authority=Developer ID Application'
  printf '%s\n' "$SIGNATURE_DETAILS" | grep -F "TeamIdentifier=${APPLE_TEAM_ID}"
  printf '%s\n' "$SIGNATURE_DETAILS" | grep -Eq 'flags=.*runtime'
  CDHASH="$(printf '%s\n' "$SIGNATURE_DETAILS" | awk -F= '/^CDHash=/{print $2; exit}')"
  [[ "$CDHASH" =~ ^[0-9A-Fa-f]{40}$ ]] || {
    echo "::error::Invalid CDHash for ${file_name}" >&2
    exit 1
  }
  CDHASH_LOWER="$(printf '%s' "$CDHASH" | tr '[:upper:]' '[:lower:]')"

  FINAL_SHA256="$(shasum -a 256 "$binary" | awk '{print $1}')"
  FINAL_SIZE="$(wc -c < "$binary" | tr -d '[:space:]')"
  rm -f "$archive"
  ditto -c -k --keepParent "$binary" "$archive"
  ARCHIVE_SHA256="$(shasum -a 256 "$archive" | awk '{print $1}')"
  ARCHIVE_SIZE="$(wc -c < "$archive" | tr -d '[:space:]')"

  set +e
  xcrun notarytool submit "$archive" \
    --key "$NOTARY_KEY_PATH" \
    --key-id "$APPLE_API_KEY_ID" \
    --issuer "$APPLE_API_ISSUER_ID" \
    --wait \
    --output-format json > "$submit_json"
  NOTARY_RC=$?
  set -e

  NOTARY_STATUS="$(jq -r '.status // empty' "$submit_json" 2>/dev/null || true)"
  SUBMISSION_ID="$(jq -r '.id // empty' "$submit_json" 2>/dev/null || true)"
  if [ "$NOTARY_RC" -ne 0 ] || [ "$NOTARY_STATUS" != "Accepted" ]; then
    echo "::error::Notarization failed for ${file_name} (status=${NOTARY_STATUS:-unavailable}, exit=${NOTARY_RC})" >&2
    exit 1
  fi
  if [[ ! "$SUBMISSION_ID" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$ ]]; then
    echo "::error::Notarization returned an invalid submission id for ${file_name}" >&2
    exit 1
  fi

  xcrun notarytool log "$SUBMISSION_ID" \
    --key "$NOTARY_KEY_PATH" \
    --key-id "$APPLE_API_KEY_ID" \
    --issuer "$APPLE_API_ISSUER_ID" \
    "$log_json" >/dev/null
  jq -e '.status == "Accepted" and ((.issues // []) | length == 0)' "$log_json" >/dev/null
  SUBMIT_SHA256="$(shasum -a 256 "$submit_json" | awk '{print $1}')"
  SUBMIT_SIZE="$(wc -c < "$submit_json" | tr -d '[:space:]')"
  LOG_SHA256="$(shasum -a 256 "$log_json" | awk '{print $1}')"
  LOG_SIZE="$(wc -c < "$log_json" | tr -d '[:space:]')"

  if [ "$(shasum -a 256 "$binary" | awk '{print $1}')" != "$FINAL_SHA256" ] \
    || [ "$(wc -c < "$binary" | tr -d '[:space:]')" != "$FINAL_SIZE" ]; then
    echo "::error::Raw binary changed during notarization: ${file_name}" >&2
    exit 1
  fi

  jq -n \
    --arg target "$target" \
    --arg version "$VERSION" \
    --arg binary_file "$file_name" \
    --arg signature_type "developer-id-application" \
    --arg team_id "$APPLE_TEAM_ID" \
    --arg cdhash "$CDHASH_LOWER" \
    --arg status "$NOTARY_STATUS" \
    --arg submission_id "$SUBMISSION_ID" \
    --arg submitted_archive "$(basename "$archive")" \
    --arg archive_sha256 "$ARCHIVE_SHA256" \
    --argjson archive_size_bytes "$ARCHIVE_SIZE" \
    --arg final_sha256 "$FINAL_SHA256" \
    --argjson final_size_bytes "$FINAL_SIZE" \
    --arg notary_response_file "$(basename "$submit_json")" \
    --arg notary_response_sha256 "$SUBMIT_SHA256" \
    --argjson notary_response_size_bytes "$SUBMIT_SIZE" \
    --arg notary_log_file "$(basename "$log_json")" \
    --arg notary_log_sha256 "$LOG_SHA256" \
    --argjson notary_log_size_bytes "$LOG_SIZE" \
    '{schema_version:1, target:$target, version:$version, binary_file:$binary_file,
      signature_type:$signature_type, team_id:$team_id, cdhash:$cdhash,
      hardened_runtime:true, status:$status, submission_id:$submission_id,
      notary_issues:0,
      submitted_archive:{file:$submitted_archive, sha256:$archive_sha256,
        size_bytes:$archive_size_bytes},
      notary_response:{file:$notary_response_file, sha256:$notary_response_sha256,
        size_bytes:$notary_response_size_bytes},
      notary_log:{file:$notary_log_file, sha256:$notary_log_sha256,
        size_bytes:$notary_log_size_bytes},
      final_sha256:$final_sha256, final_size_bytes:$final_size_bytes,
      stapled:false, ticket_delivery:"online"}' \
    > "$receipt_json"

  printf '%s  %s\n' "$FINAL_SHA256" "$file_name" > "${binary}.sha256"
  gzip -9 -n -c "$binary" > "${binary}.gz"
  GZIP_SHA256="$(shasum -a 256 "${binary}.gz" | awk '{print $1}')"
  printf '%s  %s\n' "$GZIP_SHA256" "${file_name}.gz" > "${binary}.gz.sha256"
  rm -f "$archive"
  echo "[mac-sign] ${file_name}: Developer ID + notarization ${SUBMISSION_ID} accepted"
done
