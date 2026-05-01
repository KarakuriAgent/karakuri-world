#!/usr/bin/env bash
set -euo pipefail
shopt -s inherit_errexit

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
  transfer <target_agent_id> --item <item_id> [--quantity <n>]
  transfer <target_agent_id> --money <amount>
                                                Start a transfer of one item (default quantity 1) or money to a nearby agent
  transfer-accept                                Accept the pending transfer offer (resolved from agent state)
  transfer-reject                                Reject the pending transfer offer (resolved from agent state)
  conversation-start <target_agent_id> <message> Start a conversation
  conversation-accept <message>                  Accept a conversation and reply
  conversation-reject                            Reject a conversation
  conversation-join <conversation_id>           Join an active conversation on the next turn boundary
  conversation-stay                              Stay after an inactive-check prompt
  conversation-leave [message]                   Leave after an inactive-check prompt
  conversation-speak <next_speaker_agent_id> <message...>
      [--item <item_id> [--quantity <n>] | --money <amount> | --accept | --reject]
                                                Speak in a conversation. Trailing flags optionally
                                                attach a transfer (item or money) or transfer_response.
  conversation-end <next_speaker_agent_id> <message...> [--accept | --reject]
                                                End/leave a conversation. Trailing --accept/--reject
                                                resolves a pending transfer offer; new transfers
                                                cannot be opened from end.
  map                                            Request the full map via notification
  world-agents                                   Request all agent states via notification
  status                                         Request own status (money / items / current node) via notification
  nearby-agents                                  Request nearby agents (conversation / transfer candidates) via notification
  active-conversations                           Request joinable active conversations via notification
  event                                          Request active persistent server events via notification
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

BASE_URL="${KARAKURI_API_BASE_URL%/}"
AUTH_HEADER="Authorization: Bearer ${KARAKURI_API_KEY:-}"

require_agent_api_key() {
  if [ -z "${KARAKURI_API_KEY:-}" ]; then
    echo "Error: KARAKURI_API_KEY is not set" >&2
    exit 1
  fi
}

require_positive_int() {
  # Args: <flag_label> <value>
  if ! [[ "$2" =~ ^[1-9][0-9]*$ ]]; then
    echo "Error: $1 must be a positive integer (got: $2)." >&2
    exit 1
  fi
}

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
  require_agent_api_key
  do_request -H "${AUTH_HEADER}" "${BASE_URL}$1"
}

do_notification_get() {
  do_get "$1"
}

do_post() {
  require_agent_api_key
  do_request -X POST -H "${AUTH_HEADER}" -H "Content-Type: application/json" -d "$2" "${BASE_URL}$1"
}

build_conversation_payload() {
  # Args: <context: speak|end> <next_speaker_agent_id> <message_word> [more_message_words...] [trailing_flags...]
  #
  # Trailing flags (popped from the end of the argument list):
  #   --item <item_id>          → transfer: { item: { item_id, quantity } }
  #   --quantity <n>            → 上書き対象 quantity（--item と併用、省略時 1）
  #   --money <amount>          → transfer: { money }
  #   --accept | --reject       → transfer_response
  # 排他: --item と --money / --accept|reject と --item|money は併用不可。
  # context が "end" のときは --item / --money を拒否（end は新規譲渡を開始できない）。
  local context="$1"
  local next_speaker="$2"
  shift 2

  local item_id=""
  local quantity="1"
  local quantity_set=0
  local money=""
  local response=""

  while [ $# -gt 0 ]; do
    local last="${!#}"
    case "$last" in
      --accept|--reject)
        if [ -n "$response" ]; then
          echo "Error: --accept and --reject are mutually exclusive." >&2
          exit 1
        fi
        response="${last#--}"
        set -- "${@:1:$#-1}"
        ;;
      *)
        if [ $# -ge 2 ]; then
          local prev_idx=$(($# - 1))
          local prev="${!prev_idx}"
          case "$prev" in
            --item)
              item_id="$last"
              set -- "${@:1:$#-2}"
              continue
              ;;
            --quantity)
              quantity="$last"
              quantity_set=1
              set -- "${@:1:$#-2}"
              continue
              ;;
            --money)
              money="$last"
              set -- "${@:1:$#-2}"
              continue
              ;;
          esac
        fi
        break
        ;;
    esac
  done

  if [ -n "$item_id" ] && [ -n "$money" ]; then
    echo "Error: --item and --money are mutually exclusive." >&2
    exit 1
  fi
  if [ -n "$response" ] && { [ -n "$item_id" ] || [ -n "$money" ]; }; then
    echo "Error: --accept/--reject cannot be combined with --item/--money." >&2
    exit 1
  fi
  if [ "$quantity_set" = "1" ] && [ -z "$item_id" ]; then
    echo "Error: --quantity requires --item." >&2
    exit 1
  fi
  if [ "$context" = "end" ] && { [ -n "$item_id" ] || [ -n "$money" ]; }; then
    echo "Error: conversation-end does not accept --item or --money (use --accept or --reject only)." >&2
    exit 1
  fi
  if [ $# -lt 1 ]; then
    echo "Error: message is required." >&2
    exit 1
  fi

  local message="${*}"

  if [ -n "$item_id" ]; then
    require_positive_int "--quantity" "$quantity"
    jq -nc \
      --arg message "$message" \
      --arg next_speaker "$next_speaker" \
      --arg item_id "$item_id" \
      --argjson quantity "$quantity" \
      '{message: $message, next_speaker_agent_id: $next_speaker, transfer: {item: {item_id: $item_id, quantity: $quantity}}}'
  elif [ -n "$money" ]; then
    require_positive_int "--money" "$money"
    jq -nc \
      --arg message "$message" \
      --arg next_speaker "$next_speaker" \
      --argjson money "$money" \
      '{message: $message, next_speaker_agent_id: $next_speaker, transfer: {money: $money}}'
  elif [ -n "$response" ]; then
    jq -nc \
      --arg message "$message" \
      --arg next_speaker "$next_speaker" \
      --arg response "$response" \
      '{message: $message, next_speaker_agent_id: $next_speaker, transfer_response: $response}'
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
      require_positive_int "duration_minutes" "$2"
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
    transfer_usage='Usage: karakuri.sh transfer <target_agent_id> --item <item_id> [--quantity <n>]
       karakuri.sh transfer <target_agent_id> --money <amount>'
    [ $# -lt 1 ] && { printf '%s\n' "$transfer_usage" >&2; exit 1; }
    transfer_target="$1"
    shift
    transfer_item_id=""
    transfer_quantity="1"
    transfer_money=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --item)
          [ $# -ge 2 ] || { echo "Error: --item requires a value." >&2; exit 1; }
          transfer_item_id="$2"
          shift 2
          ;;
        --quantity)
          [ $# -ge 2 ] || { echo "Error: --quantity requires a value." >&2; exit 1; }
          transfer_quantity="$2"
          shift 2
          ;;
        --money)
          [ $# -ge 2 ] || { echo "Error: --money requires a value." >&2; exit 1; }
          transfer_money="$2"
          shift 2
          ;;
        *)
          printf '%s\n' "$transfer_usage" >&2
          exit 1
          ;;
      esac
    done
    if [ -n "$transfer_item_id" ] && [ -n "$transfer_money" ]; then
      echo "Error: --item and --money are mutually exclusive." >&2
      exit 1
    fi
    if [ -z "$transfer_item_id" ] && [ -z "$transfer_money" ]; then
      printf '%s\n' "$transfer_usage" >&2
      exit 1
    fi
    if [ -n "$transfer_item_id" ]; then
      require_positive_int "--quantity" "$transfer_quantity"
      transfer_payload="$(jq -nc \
        --arg target_agent_id "$transfer_target" \
        --arg item_id "$transfer_item_id" \
        --argjson quantity "$transfer_quantity" \
        '{target_agent_id: $target_agent_id, item: {item_id: $item_id, quantity: $quantity}}')"
    else
      require_positive_int "--money" "$transfer_money"
      transfer_payload="$(jq -nc \
        --arg target_agent_id "$transfer_target" \
        --argjson money "$transfer_money" \
        '{target_agent_id: $target_agent_id, money: $money}')"
    fi
    do_post "/agents/transfer" "$transfer_payload"
    ;;
  transfer-accept)
    # body 不要。pending_transfer_id から自動解決される。
    do_post "/agents/transfer/accept" '{}'
    ;;
  transfer-reject)
    # body 不要。pending_transfer_id から自動解決される。
    do_post "/agents/transfer/reject" '{}'
    ;;
  wait)
    [ $# -lt 1 ] && { echo "Usage: karakuri.sh wait <duration>" >&2; exit 1; }
    require_positive_int "duration" "$1"
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
    [ $# -lt 2 ] && { echo "Usage: karakuri.sh conversation-speak <next_speaker_agent_id> <message> [--item <id> [--quantity <n>] | --money <amount> | --accept | --reject]" >&2; exit 1; }
    speak_payload="$(build_conversation_payload "speak" "$@")"
    do_post "/agents/conversation/speak" "$speak_payload"
    ;;
  conversation-end)
    [ $# -lt 2 ] && { echo "Usage: karakuri.sh conversation-end <next_speaker_agent_id> <message> [--accept | --reject]" >&2; exit 1; }
    end_payload="$(build_conversation_payload "end" "$@")"
    do_post "/agents/conversation/end" "$end_payload"
    ;;
  map)
    do_notification_get "/agents/map"
    ;;
  world-agents)
    do_notification_get "/agents/world-agents"
    ;;
  status)
    do_notification_get "/agents/status"
    ;;
  nearby-agents)
    do_notification_get "/agents/nearby-agents"
    ;;
  active-conversations)
    do_notification_get "/agents/active-conversations"
    ;;
  event|get-event)
    if [ $# -gt 0 ]; then
      echo "Error: '${command}' takes no arguments. Persistent server events are managed via Discord slash commands or /api/admin/server-events*." >&2
      exit 1
    fi
    do_notification_get "/agents/event"
    ;;
  *)
    echo "Error: Unknown command '${command}'" >&2
    usage >&2
    exit 1
    ;;
esac
