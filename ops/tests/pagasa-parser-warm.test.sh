#!/usr/bin/env bash
set -euo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WARMER="$TEST_DIR/../pagasa-parser-warm.sh"
TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TEMP_DIR"' EXIT

export PATH="$TEST_DIR/bin:$PATH"
export MOCK_CALL_LOG="$TEMP_DIR/calls.log"
export PARSER_BASE_URL="http://parser.test/api/v1"
export PAGASA_CYCLONE_DATA_URL="https://pagasa.test/cyclone.dat"
export WARMER_LOCK_FILE="$TEMP_DIR/warmer.lock"
export MAX_PARSE_PER_RUN=1

export MOCK_SCENARIO=priority
: > "$MOCK_CALL_LOG"
bash "$WARMER" >/dev/null
[[ "$(wc -l < "$MOCK_CALL_LOG" | tr -d ' ')" -eq 1 ]]
priority_call="$(head -n 1 "$MOCK_CALL_LOG")"
[[ "$priority_call" == *TCB%233_josie.pdf ]]

export MOCK_SCENARIO=quarantine
: > "$MOCK_CALL_LOG"
bash "$WARMER" >/dev/null
[[ "$(wc -l < "$MOCK_CALL_LOG" | tr -d ' ')" -eq 1 ]]
quarantine_call="$(head -n 1 "$MOCK_CALL_LOG")"
[[ "$quarantine_call" == *TCB%2321_francisco.pdf ]]

printf 'pagasa-parser-warm tests passed\n'
