#!/usr/bin/env bash
set -euo pipefail

# karakuri.sh — karakuri-world API wrapper
#
# Required environment variables:
#   KARAKURI_API_BASE_URL  REST API base URL (e.g. https://karakuri.example.com/api)
#   KARAKURI_API_KEY       API key issued at agent registration
#
# Requires: curl, jq

usage() {
  cat <<'EOF'
Usage: karakuri.sh <command> [arguments]

Commands:
  move <target_node_id>                          Move to a target node
  perception                                     Request refreshed perception via notification
  actions                                        Request available actions via notification
  action <action_id> [duration_minutes]          Execute an action
  use-item <item_id>                             Use an item from inventory
  wait <duration>                                 Wait (1-6, in 10-minute units)
  transfer <target_agent_id> [items_json] [money]
                                                Start an item/money transfer to a nearby agent
  transfer-accept <transfer_id>                  Accept a pending transfer offer
  transfer-reject <transfer_id>                  Reject a pending transfer offer
  conversation-start <target_agent_id> <message> Start a conversation
  conversation-accept <message>                  Accept a conversation and reply
  conversation-reject                            Reject a conversation
  conversation-join <conversation_id>           Join an active conversation on the next turn boundary
  conversation-stay                              Stay after an inactive-check prompt
  conversation-leave [message]                   Leave after an inactive-check prompt
  conversation-speak <next_speaker_agent_id> <message> [extra_json]
                                                Speak in a conversation; optional extra_json adds
                                                {"transfer": {...}} or {"transfer_response": "accept"|"reject"}
  conversation-end <next_speaker_agent_id> <message> [extra_json]
                                                End/leave a conversation; optional extra_json adds
                                                {"transfer_response": "accept"|"reject"}
  map                                            Request the full map via notification
  world-agents                                   Request all agent states via notification
EOF
}

if [ $# -lt 1 ]; then
  usage
  exit 1
fi

if [ "$1" = "--help" ] || [ "$1" = "-h" ] || [ "$1" = "help" ]; then
  usage
  exit 0
fi

if [ -z "${KARAKURI_API_BASE_URL:-}" ]; then
  echo "Error: KARAKURI_API_BASE_URL is not set" >&2
  exit 1
fi
if [ -z "${KARAKURI_API_KEY:-}" ]; then
  echo "Error: KARAKURI_API_KEY is not set" >&2
  exit 1
fi

BASE_URL="${KARAKURI_API_BASE_URL%/}"
AUTH_HEADER="Authorization: Bearer ${KARAKURI_API_KEY}"

json_obj() {
  local args=()
  while [ $# -ge 2 ]; do
    args+=(--arg "$1" "$2")
    shift 2
  done
  jq -nc "${args[@]}" '$ARGS.named'
}

do_request() {
  if [ "${KARAKURI_DRY_RUN:-0}" = "1" ]; then
    # ドライランモード: curl を呼ばず、リクエスト構造を JSON で stdout に出力する。
    # テスト (apps/server/test/unit/skills/karakuri-script.test.ts) で payload 正当性を検証するための仕組み
    local method="GET" url="" body=""
    while [ $# -gt 0 ]; do
      case "$1" in
        -X) method="$2"; shift 2 ;;
        -H) shift 2 ;;
        -d) body="$2"; shift 2 ;;
        -s|-w) shift ;;
        *) url="$1"; shift ;;
      esac
    done
    jq -nc \
      --arg method "$method" \
      --arg url "$url" \
      --arg body "$body" \
      '{method: $method, url: $url, body: ($body | (try fromjson catch null))}'
    return 0
  fi

  local response code body
  response=$(curl -s -w '\n%{http_code}' "$@")
  code="${response##*$'\n'}"
  body="${response%$'\n'"${code}"}"
  printf '%s\n' "${body}"
  [ "${code}" -ge 200 ] && [ "${code}" -lt 300 ]
}

do_get() {
  do_request -H "${AUTH_HEADER}" "${BASE_URL}$1"
}

do_notification_get() {
  do_get "$1"
}

do_post() {
  do_request -X POST -H "${AUTH_HEADER}" -H "Content-Type: application/json" -d "$2" "${BASE_URL}$1"
}

build_conversation_payload() {
  # Args: <next_speaker_agent_id> <message_word> [more_message_words...] [extra_json]
  # If the last argument starts with '{' and parses as JSON, treat it as extra payload
  # to merge (e.g. {"transfer":{...}} or {"transfer_response":"accept"}).
  local next_speaker="$1"
  shift
  local extra_json=""
  if [ $# -ge 2 ]; then
    local last="${!#}"
    if [[ "$last" == \{* ]] && printf '%s' "$last" | jq empty >/dev/null 2>&1; then
      extra_json="$last"
      set -- "${@:1:$#-1}"
    fi
  fi
  local message="${*}"
  if [ -n "$extra_json" ]; then
    jq -nc \
      --arg message "$message" \
      --arg next_speaker "$next_speaker" \
      --argjson extra "$extra_json" \
      '{message: $message, next_speaker_agent_id: $next_speaker} + $extra'
  else
    json_obj message "${message}" next_speaker_agent_id "${next_speaker}"
  fi
}

command="$1"
shift

case "${command}" in
  move)
    [ $# -lt 1 ] && { echo "Usage: karakuri.sh move <target_node_id>" >&2; exit 1; }
    do_post "/agents/move" "$(json_obj target_node_id "$1")"
    ;;
  perception)
    do_notification_get "/agents/perception"
    ;;
  actions)
    do_notification_get "/agents/actions"
    ;;
  action)
    [ $# -lt 1 ] && { echo "Usage: karakuri.sh action <action_id> [duration_minutes]" >&2; exit 1; }
    if [ $# -ge 2 ]; then
      do_post "/agents/action" "$(jq -nc --arg action_id "$1" --argjson duration_minutes "$2" '{action_id: $action_id, duration_minutes: $duration_minutes}')"
    else
      do_post "/agents/action" "$(json_obj action_id "$1")"
    fi
    ;;
  use-item)
    [ $# -lt 1 ] && { echo "Usage: karakuri.sh use-item <item_id>" >&2; exit 1; }
    do_post "/agents/use-item" "$(json_obj item_id "$1")"
    ;;
  transfer)
    [ $# -lt 1 ] && { echo "Usage: karakuri.sh transfer <target_agent_id> [items_json] [money]" >&2; exit 1; }
    transfer_target="$1"
    transfer_items_arg="${2:-}"
    transfer_money_arg="${3:-}"
    transfer_payload="$(jq -nc \
      --arg target_agent_id "$transfer_target" \
      --arg items "$transfer_items_arg" \
      --arg money "$transfer_money_arg" \
      '{target_agent_id: $target_agent_id}
        + (if $items == "" then {} else {items: ($items | fromjson)} end)
        + (if $money == "" then {} else {money: ($money | tonumber)} end)')"
    do_post "/agents/transfer" "$transfer_payload"
    ;;
  transfer-accept)
    [ $# -lt 1 ] && { echo "Usage: karakuri.sh transfer-accept <transfer_id>" >&2; exit 1; }
    do_post "/agents/transfer/accept" "$(json_obj transfer_id "$1")"
    ;;
  transfer-reject)
    [ $# -lt 1 ] && { echo "Usage: karakuri.sh transfer-reject <transfer_id>" >&2; exit 1; }
    do_post "/agents/transfer/reject" "$(json_obj transfer_id "$1")"
    ;;
  wait)
    [ $# -lt 1 ] && { echo "Usage: karakuri.sh wait <duration>" >&2; exit 1; }
    do_post "/agents/wait" "$(jq -nc --argjson duration "$1" '{duration: $duration}')"
    ;;
  conversation-start)
    [ $# -lt 2 ] && { echo "Usage: karakuri.sh conversation-start <target_agent_id> <message>" >&2; exit 1; }
    do_post "/agents/conversation/start" "$(json_obj target_agent_id "$1" message "${*:2}")"
    ;;
  conversation-accept)
    [ $# -lt 1 ] && { echo "Usage: karakuri.sh conversation-accept <message>" >&2; exit 1; }
    do_post "/agents/conversation/accept" "$(json_obj message "${*:1}")"
    ;;
  conversation-reject)
    do_post "/agents/conversation/reject" '{}'
    ;;
  conversation-join)
    [ $# -lt 1 ] && { echo "Usage: karakuri.sh conversation-join <conversation_id>" >&2; exit 1; }
    do_post "/agents/conversation/join" "$(json_obj conversation_id "$1")"
    ;;
  conversation-stay)
    do_post "/agents/conversation/stay" '{}'
    ;;
  conversation-leave)
    if [ $# -ge 1 ]; then
      do_post "/agents/conversation/leave" "$(json_obj message "${*:1}")"
    else
      do_post "/agents/conversation/leave" '{}'
    fi
    ;;
  conversation-speak)
    [ $# -lt 2 ] && { echo "Usage: karakuri.sh conversation-speak <next_speaker_agent_id> <message>" >&2; exit 1; }
    do_post "/agents/conversation/speak" "$(build_conversation_payload "$@")"
    ;;
  conversation-end)
    [ $# -lt 2 ] && { echo "Usage: karakuri.sh conversation-end <next_speaker_agent_id> <message>" >&2; exit 1; }
    do_post "/agents/conversation/end" "$(build_conversation_payload "$@")"
    ;;
  map)
    do_notification_get "/agents/map"
    ;;
  world-agents)
    do_notification_get "/agents/world-agents"
    ;;
  *)
    echo "Error: Unknown command '${command}'" >&2
    usage >&2
    exit 1
    ;;
esac
