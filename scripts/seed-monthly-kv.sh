#!/usr/bin/env bash
set -euo pipefail

# Seed the monthly KV store with wiki_path values from the D1 deaths table.
#
# - Derives year-month buckets from deaths.created_at using SQLite strftime('%Y-%m', created_at) (UTC).
# - For each bucket, writes a sorted, deduplicated, '|' delimited list to KV key: wiki_paths:YYYY-MM
# - Requires: wrangler CLI, jq
#
# Usage examples:
#   scripts/seed-monthly-kv.sh                      # uses defaults
#   scripts/seed-monthly-kv.sh --env production     # target wrangler env
#   scripts/seed-monthly-kv.sh --db my-db-name      # override D1 database name
#   scripts/seed-monthly-kv.sh --binding celebrity_death_bot_kv  # override KV binding
#   scripts/seed-monthly-kv.sh --dry-run            # print what would be written

DB_NAME="celebrity-death-bot"
KV_BINDING="celebrity_death_bot_kv"
ENV_NAME=""
PROFILE_NAME=""
REMOTE=1
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env)
      ENV_NAME="$2"; shift 2 ;;
    --profile)
      PROFILE_NAME="$2"; shift 2 ;;
    --db)
      DB_NAME="$2"; shift 2 ;;
    --binding)
      KV_BINDING="$2"; shift 2 ;;
    --local)
      REMOTE=0; shift ;;
    --dry-run)
      DRY_RUN=1; shift ;;
    -h|--help)
      sed -n '1,80p' "$0"; exit 0 ;;
    *)
      echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

command -v npx >/dev/null 2>&1 || { echo "npx is required (to run wrangler)" >&2; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "jq is required" >&2; exit 1; }

# Use npx to invoke wrangler (resolves local devDependency or downloads if needed)
WRANGLER=(npx wrangler)

ENV_FLAG=()
if [[ -n "$ENV_NAME" ]]; then
  ENV_FLAG=(--env "$ENV_NAME")
fi

PROFILE_FLAG=()
if [[ -n "$PROFILE_NAME" ]]; then
  PROFILE_FLAG=(--profile "$PROFILE_NAME")
fi

REMOTE_OR_LOCAL=()
if (( REMOTE == 1 )); then
  REMOTE_OR_LOCAL=(--remote)
else
  REMOTE_OR_LOCAL=(--local)
fi

CONFIG_FLAG=()
if [[ -f ./wrangler.jsonc ]]; then
  CONFIG_FLAG=(--config ./wrangler.jsonc)
fi

echo "Exporting wiki_path values from D1 ($DB_NAME)..." >&2

# Note: created_at is stored as UTC (CURRENT_TIMESTAMP). This seeds per UTC month.
SQL='SELECT strftime("%Y-%m", created_at) AS ym, wiki_path FROM deaths ORDER BY ym, wiki_path;'

RAW_JSON=$("${WRANGLER[@]}" d1 execute "$DB_NAME" "${ENV_FLAG[@]}" "${PROFILE_FLAG[@]}" "${REMOTE_OR_LOCAL[@]}" "${CONFIG_FLAG[@]}" --command "$SQL" --json)

if [[ -z "$RAW_JSON" ]]; then
  echo "No data returned from D1; aborting." >&2
  exit 1
fi

# Group rows by ym, sort wiki_path within each, and join with '|'
# Support both top-level .results and newer nested .result[].results shapes.
mapfile -t LINES < <(echo "$RAW_JSON" | jq -r '
  def flatten_results:
    if type == "object" then
      if has("result") then
        (.result | if type == "array" then map(.results // []) | add else (.results // []) end)
      elif has("results") then
        (.results // [])
      else [] end
    elif type == "array" then
      (map(.results // []) | add)
    else [] end;

  flatten_results
  | sort_by(.ym, .wiki_path)
  | group_by(.ym)
  | .[]
  | (.[0].ym) as $ym
  | ([.[].wiki_path] | unique | sort | join("|")) as $val
  | "\($ym)\t\($val)"')

if (( ${#LINES[@]} == 0 )); then
  echo "No rows found in deaths table; nothing to seed." >&2
  exit 0
fi

for line in "${LINES[@]}"; do
  ym=${line%%$'\t'*}
  val=${line#*$'\t'}
  key="wiki_paths:$ym"
  if (( DRY_RUN == 1 )); then
    echo "[dry-run] kv:key put --binding $KV_BINDING $key (len=${#val})"
  else
    echo "Seeding $key (len=${#val})" >&2
    # Prefer modern subcommand form: `kv key put`; fall back to legacy `kv:key put` if needed.
    if "${WRANGLER[@]}" kv key put --help >/dev/null 2>&1; then
      "${WRANGLER[@]}" kv key put --binding "$KV_BINDING" "${ENV_FLAG[@]}" "${PROFILE_FLAG[@]}" "${CONFIG_FLAG[@]}" "$key" "$val" >/dev/null
    else
      "${WRANGLER[@]}" kv:key put --binding "$KV_BINDING" "${ENV_FLAG[@]}" "${PROFILE_FLAG[@]}" "${CONFIG_FLAG[@]}" "$key" "$val" >/dev/null
    fi
  fi
done

echo "Done." >&2
