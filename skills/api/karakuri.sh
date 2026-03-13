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
  perception                                     Get perception data
  actions                                        List available actions
  action <action_id>                             Execute an action
  conversation-start <target_agent_id> <message> Start a conversation
  conversation-accept <conversation_id>          Accept a conversation
  conversation-reject <conversation_id>          Reject a conversation
  conversation-speak <conversation_id> <message> Speak in a conversation
  server-event-select <server_event_id> <choice_id>  Select a server event choice
  map                                            Get full map
  world-agents                                   List all agents
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

do_post() {
  do_request -X POST -H "${AUTH_HEADER}" -H "Content-Type: application/json" -d "$2" "${BASE_URL}$1"
}

command="$1"
shift

case "${command}" in
  move)
    [ $# -lt 1 ] && { echo "Usage: karakuri.sh move <target_node_id>" >&2; exit 1; }
    do_post "/agents/move" "$(json_obj target_node_id "$1")"
    ;;
  perception)
    do_get "/agents/perception"
    ;;
  actions)
    do_get "/agents/actions"
    ;;
  action)
    [ $# -lt 1 ] && { echo "Usage: karakuri.sh action <action_id>" >&2; exit 1; }
    do_post "/agents/action" "$(json_obj action_id "$1")"
    ;;
  conversation-start)
    [ $# -lt 2 ] && { echo "Usage: karakuri.sh conversation-start <target_agent_id> <message>" >&2; exit 1; }
    do_post "/agents/conversation/start" "$(json_obj target_agent_id "$1" message "${*:2}")"
    ;;
  conversation-accept)
    [ $# -lt 1 ] && { echo "Usage: karakuri.sh conversation-accept <conversation_id>" >&2; exit 1; }
    do_post "/agents/conversation/accept" "$(json_obj conversation_id "$1")"
    ;;
  conversation-reject)
    [ $# -lt 1 ] && { echo "Usage: karakuri.sh conversation-reject <conversation_id>" >&2; exit 1; }
    do_post "/agents/conversation/reject" "$(json_obj conversation_id "$1")"
    ;;
  conversation-speak)
    [ $# -lt 2 ] && { echo "Usage: karakuri.sh conversation-speak <conversation_id> <message>" >&2; exit 1; }
    do_post "/agents/conversation/speak" "$(json_obj conversation_id "$1" message "${*:2}")"
    ;;
  server-event-select)
    [ $# -lt 2 ] && { echo "Usage: karakuri.sh server-event-select <server_event_id> <choice_id>" >&2; exit 1; }
    do_post "/agents/server-event/select" "$(json_obj server_event_id "$1" choice_id "$2")"
    ;;
  map)
    do_get "/agents/map"
    ;;
  world-agents)
    do_get "/agents/world-agents"
    ;;
  *)
    echo "Error: Unknown command '${command}'" >&2
    usage >&2
    exit 1
    ;;
esac
