export PATH=$PATH:$(pwd)

lsc() {
    local script
    script=$(find $(echo $PATH | tr ':' ' ') -maxdepth 1 \( -type f -o -type l \) 2>/dev/null | sort | uniq | fzf --reverse --preview 'head -n 200 {}')

    basePath=$(basename "$script")
    if [[ -n $script ]]; then
        print -z "$basePath"
    fi
}


COLOR_DEF="\[$(tput sgr0)\]"
COLOR_USR="\[$(tput setaf 243)\]"
COLOR_DIR="\[$(tput setaf 6)\]"
COLOR_GIT="\[$(tput setaf 2)\]"

function parse_git_branch {
    git branch 2> /dev/null | sed -n -e 's/^\* \(.*\)/[\1]/p'
}

function format_date {
    date +"%d/%m/%y %H:%M:%S"
}

export PS1="${COLOR_USR}[\$(format_date)]${COLOR_DEF} ${COLOR_DIR}\w${COLOR_DEF} ${COLOR_GIT}\$(parse_git_branch)${COLOR_DEF}$ "
