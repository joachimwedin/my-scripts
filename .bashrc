export PATH="$PATH:/home/joachim-wedin/repos/my-scripts"
export PATH="$PATH:/home/joachim-wedin/.local/bin"

# Tab completion for `run <subcommand>` -- fetches candidates from `run ls`
# at completion time (rather than hardcoding them) so a newly registered op
# becomes tab-completable with no further edit here. Only the first
# positional argument (the subcommand name) is completed; flags like
# --force after it are left to bash's default filename completion.
_run_completions() {
    local cur
    cur="${COMP_WORDS[COMP_CWORD]}"
    if [[ $COMP_CWORD -eq 1 ]]; then
        COMPREPLY=($(compgen -W "$(run ls 2>/dev/null)" -- "$cur"))
    fi
}
complete -F _run_completions run

lsc() {
    local script
    script=$(find $(echo $PATH | tr ':' ' ') -maxdepth 1 \( -type f -o -type l \) 2>/dev/null | sort | uniq | fzf --reverse --preview 'head -n 200 {}')

    basePath=$(basename "$script")
    if [[ -n $script ]]; then
        print -z "$basePath"
    fi
}

alias cdx='cd ~/sandbox-files'

cbox() {
  local workdir
  workdir=$(git rev-parse --show-toplevel 2>/dev/null) || workdir=$PWD
  local name="cbox-$(basename "$workdir")"
  local config="$HOME/.config/sandbox-setup/sandboxes.json"

  mkdir -p "$HOME/sandbox-files"
  local paths=("$workdir" "$HOME/sandbox-files")
  local repo
  while IFS= read -r repo; do
    paths+=("$HOME/repos/$repo")
  done < <(jq -r '.[]' "$config")

  local superset_env=()
  local k v
  while IFS='=' read -r k v; do
    [ -z "$k" ] && continue
    case "$k" in
      SUPERSET_HOST_AGENT_HOOK_URL)
        v=$(printf '%s' "$v" | sed -E 's#://(127\.0\.0\.1|localhost)#://host.docker.internal#')
        ;;
    esac
    superset_env+=(-e "$k=$v")
  done < <(env | grep '^SUPERSET_')

  if ! sbx ls -q | grep -qx "$name"; then
    mkdir -p "$HOME/.claude/projects"
    sbx create --name "$name" claude \
      -e "HOST_HOME=$HOME" \
      "${superset_env[@]}" \
      "${paths[@]}" "$SUPERSET_HOME_DIR/hooks" "$HOME/.claude/projects"

    local sandbox_settings sync_cmd
    sync_cmd='rsync -a --update /home/agent/.claude/projects/ "$HOST_HOME/.claude/projects/" 2>/dev/null || true'
    sandbox_settings=$(mktemp)
    jq --arg cmd "$sync_cmd" \
      '.hooks.Stop += [{"hooks":[{"type":"command","command":$cmd}]}]' \
      ~/.claude/settings.json > "$sandbox_settings"
    chmod 644 "$sandbox_settings"
    sbx cp "$sandbox_settings" "$name":/home/agent/.claude/settings.json
    rm -f "$sandbox_settings"

    sbx cp ~/.claude/statusline-command.sh "$name":/home/agent/.claude/statusline-command.sh
  fi

  local skill
  for skill in "$HOME/.claude/skills"/*; do
    sbx cp -L "$skill" "$name":/home/agent/.claude/skills/ || return 1
  done

  sbx run --name "$name" -- --dangerously-skip-permissions "$@"
}

COLOR_DEF='\[\e[0m\]'
COLOR_TIME='\[\e[32m\]'
COLOR_DIR='\[\e[96m\]'
COLOR_GIT='\[\e[95m\]'
COLOR_DOLLAR='\[\e[0m\]'

function parse_git_branch() {
    git branch 2> /dev/null | sed -n -e 's/^\* \(.*\)/ (\1)/p'
}

PROMPT_COMMAND='\
PS1_CMD="${COLOR_TIME}[\D{%d/%m/%y} \t] ${COLOR_DIR}\w${COLOR_GIT}$(parse_git_branch)${COLOR_DOLLAR} \\$ ${COLOR_DEF}";\
PS1=${PS1_CMD}'
