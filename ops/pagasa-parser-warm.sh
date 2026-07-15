#!/usr/bin/env bash
set -uo pipefail

BASE_URL="${PARSER_BASE_URL:-http://127.0.0.1:12464/api/v1}"
BASE_URL="${BASE_URL%/}"
MAX_PARSE_PER_RUN="${MAX_PARSE_PER_RUN:-2}"
HTTP_TIMEOUT_SECONDS="${HTTP_TIMEOUT_SECONDS:-15}"
PARSE_TIMEOUT_SECONDS="${PARSE_TIMEOUT_SECONDS:-70}"
LOCK_FILE="${WARMER_LOCK_FILE:-/var/lib/pagasa-warm/pagasa-parser-warm.lock}"
CYCLONE_DATA_URL="${PAGASA_CYCLONE_DATA_URL:-https://pubfiles.pagasa.dost.gov.ph/tamss/weather/cyclone.dat}"

log() {
    printf '%s event=pagasa_parser.warmer %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

for command in curl jq flock; do
    if ! command -v "$command" >/dev/null 2>&1; then
        log "status=error reason=missing_dependency command=$command"
        exit 1
    fi
done

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
    log "status=skipped reason=already_running"
    exit 0
fi

if ! list_json="$(curl --fail --silent --show-error \
    --max-time "$HTTP_TIMEOUT_SECONDS" \
    "$BASE_URL/bulletin/list")"; then
    log "status=error step=list"
    exit 1
fi

if ! jq -e '.error == false and (.bulletins | type == "array")' \
    >/dev/null <<<"$list_json"; then
    log "status=error step=list reason=invalid_response"
    exit 1
fi

active_cyclone=""
if cyclone_data="$(curl --fail --silent --show-error \
    --max-time "$HTTP_TIMEOUT_SECONDS" \
    "$CYCLONE_DATA_URL")"; then
    first_line="${cyclone_data%%$'\n'*}"
    if [[ "$first_line" =~ ^([A-Z][A-Z0-9-]*)\{ ]]; then
        active_cyclone="${BASH_REMATCH[1],,}"
        log "status=success step=priority active_cyclone=$active_cyclone"
    fi
else
    log "status=warning step=priority reason=cyclone_marker_unavailable"
fi

parse_attempts=0
while IFS= read -r file; do
    [[ -n "$file" ]] || continue
    encoded_file="$(jq -nr --arg value "$file" '$value | @uri')"

    if ! has_json="$(curl --fail --silent --show-error \
        --max-time "$HTTP_TIMEOUT_SECONDS" \
        "$BASE_URL/bulletin/has/$encoded_file")"; then
        log "status=error step=has file=$file"
        continue
    fi

    if [[ "$(jq -r '.parsed // false' <<<"$has_json")" == "true" ]]; then
        continue
    fi
    if [[ "$(jq -r '.parsing // false' <<<"$has_json")" == "true" ]]; then
        log "status=skipped reason=parse_in_flight file=$file"
        continue
    fi
    if [[ "$(jq -r '.downloading // false' <<<"$has_json")" == "true" ]]; then
        log "status=skipped reason=download_in_flight file=$file"
        continue
    fi

    retry_after="$(jq -r '.parseFailure.retryAfterSeconds // 0' <<<"$has_json")"
    if (( retry_after > 0 )); then
        attempts="$(jq -r '.parseFailure.attempts // 0' <<<"$has_json")"
        log "status=skipped reason=cooldown file=$file attempts=$attempts retry_after_seconds=$retry_after"
        continue
    fi

    if (( parse_attempts >= MAX_PARSE_PER_RUN )); then
        log "status=complete reason=run_limit max=$MAX_PARSE_PER_RUN"
        break
    fi

    if [[ "$(jq -r '.downloaded // false' <<<"$has_json")" != "true" ]]; then
        if ! curl --fail --silent --show-error \
            --max-time "$PARSE_TIMEOUT_SECONDS" \
            "$BASE_URL/bulletin/download/$encoded_file" >/dev/null; then
            log "status=error step=download file=$file"
            continue
        fi
        log "status=success step=download file=$file"
    fi

    parse_attempts=$((parse_attempts + 1))
    if curl --fail --silent --show-error \
        --max-time "$PARSE_TIMEOUT_SECONDS" \
        "$BASE_URL/bulletin/parse/$encoded_file" >/dev/null; then
        log "status=success step=parse file=$file"
    else
        log "status=error step=parse file=$file"
    fi
done < <(jq -r --arg active "$active_cyclone" '
    .bulletins
    | sort_by([
        (if $active != "" and (.name | ascii_downcase) == $active then 0 else 1 end),
        (-.count),
        .name
      ])
    | .[].file
' <<<"$list_json")

log "status=complete parse_attempts=$parse_attempts"
