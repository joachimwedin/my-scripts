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

CYAN='\033[36m'; GREEN='\033[32m'; YELLOW='\033[33m'; RED='\033[31m'; RESET='\033[0m'

BRANCH=""
git rev-parse --git-dir > /dev/null 2>&1 && BRANCH=" | 🌿 $(git branch --show-current 2>/dev/null)"

#echo -e "📁 ${DIR##*/}$BRANCH | ${CYAN}$MODEL${RESET} | ${YELLOW}${CTX_USAGE}${RESET} (${PCT_FORMATTED}%)"
echo -e "📁 ${DIR}$BRANCH | 🤖 ${CYAN}$MODEL${RESET} | 🧠 ${YELLOW}${CTX_USAGE}${RESET} (${PCT_FORMATTED}%)"
