#!/bin/bash
input=$(cat)



MODEL=$(echo "$input" | jq -r '.model.display_name')
#DIR=$(echo "$input" | jq -r '.workspace.current_dir')
DIR=$(echo "~/${PWD#"$HOME"/}")
PCT=$(echo "$input" | jq -r '.context_window.used_percentage // 0')
PCT_FORMATTED=$(bc <<< "scale=1; $PCT * 1.0")
INPUT_TOKENS=$(echo "$input" | jq -r '.context_window.total_input_tokens // 0')
OUTPUT_TOKENS=$(echo "$input" | jq -r '.context_window.total_output_tokens // 0')
CTX_USAGE=$(bc <<< "scale=0; ($INPUT_TOKENS + $OUTPUT_TOKENS) / 1000")k

LAVENDER='\033[38;5;147m'; CYAN='\033[36m'; GREEN='\033[32m'; YELLOW='\033[33m'; RED='\033[31m'; RESET='\033[0m'

BRANCH=""
git rev-parse --git-dir > /dev/null 2>&1 && BRANCH=" | 🌿 $(git branch --show-current 2>/dev/null)"

#echo -e "📁 ${DIR##*/}$BRANCH | ${CYAN}$MODEL${RESET} | ${YELLOW}${CTX_USAGE}${RESET} (${PCT_FORMATTED}%)"
limit_segment() {
  local used="$1" resets_at="$2" left countdown
  [ -z "$used" ] && return
  printf "%b%.0f%%%b" "$LAVENDER" "$used" "$RESET"
  [ -z "$resets_at" ] && return
  left=$(( resets_at - $(date +%s) ))
  [ "$left" -lt 0 ] && left=0
  if [ "$left" -ge 86400 ]; then countdown="$((left / 86400))d"
  elif [ "$left" -ge 3600 ]; then countdown="$((left / 3600))h$(printf '%02d' $((left % 3600 / 60)))m"
  else countdown="$((left / 60))m"; fi
  printf " (%s)" "$countdown"
}

FIVE_H=$(echo "$input" | jq -r '.rate_limits.five_hour.used_percentage // empty')
FIVE_H_RESET=$(echo "$input" | jq -r '.rate_limits.five_hour.resets_at // empty')
LIMITS=""
[ -n "$FIVE_H" ] && LIMITS=" | 🔥 $(limit_segment "$FIVE_H" "$FIVE_H_RESET")"

echo -e "📁 ${DIR}$BRANCH | 🤖 ${CYAN}$MODEL${RESET} | 🧠 ${YELLOW}${CTX_USAGE}${RESET} (${PCT_FORMATTED}%)${LIMITS}"
