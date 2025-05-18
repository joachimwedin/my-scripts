export PATH=$PATH:$REPO_DIR/my-scripts

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
