export PATH="$PATH:/home/joachim-wedin/repos/my-scripts"
export PATH="$PATH:/home/joachim-wedin/.local/bin"

lsc() {
    local script
    script=$(find $(echo $PATH | tr ':' ' ') -maxdepth 1 \( -type f -o -type l \) 2>/dev/null | sort | uniq | fzf --reverse --preview 'head -n 200 {}')

    basePath=$(basename "$script")
    if [[ -n $script ]]; then
        print -z "$basePath"
    fi
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
