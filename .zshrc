export PATH=$PATH:$REPO_DIR/my-scripts

# `compdef` (used below to register completion for `run`) is provided by
# zsh's completion system, which needs to be initialized once via compinit.
# Guarded so this is a no-op if something earlier in the shell startup
# (oh-my-zsh, prezto, etc.) already initialized it.
if ! whence -w compdef &>/dev/null; then
    autoload -Uz compinit
    compinit
fi

# Tab completion for `run <subcommand>` -- fetches candidates from `run ls`
# at completion time (rather than hardcoding them) so a newly registered op
# becomes tab-completable with no further edit here. Only the first
# positional argument (the subcommand name) is completed; flags like
# --force after it are left to zsh's default completion.
_run() {
    local -a subcommands
    if (( CURRENT == 2 )); then
        subcommands=(${(f)"$(run ls 2>/dev/null)"})
        compadd -a subcommands
    fi
}
compdef _run run

lsc() {
    local script
    script=$(gfind $(echo $PATH | tr ':' ' ') -maxdepth 1 \( -type f -o -type l \) 2>/dev/null | sort | uniq | fzf --reverse --preview 'head -n 200 {}')

    basePath=$(basename "$script")
    if [[ -n $script ]]; then
        print -z "$basePath"
    fi
}

# CURRENT BRANCH / PATH
COLOR_DEF='%F{normal}'
COLOR_USR='%F{243}'
COLOR_DIR='%F{cyan}'
COLOR_GIT='%F{green}'

function parse_git_branch() {
    git branch 2> /dev/null | sed -n -e 's/^\* \(.*\)/[\1]/p'
}

setopt PROMPT_SUBST

#export PROMPT='${COLOR_USR}[%D{%d/%m/%y %H:%M:%S}]%f ${COLOR_USR}%n%f ${COLOR_DIR}%~%f ${COLOR_GIT}$(parse_git_branch)%f ${COLOR_DEF}$%f '
export PROMPT='${COLOR_USR}[%D{%d/%m/%y %H:%M:%S}]%f ${COLOR_DIR}%~%f ${COLOR_GIT}$(parse_git_branch)%f ${COLOR_DEF}$%f '

alias cdr='cd $REPO_DIR'
