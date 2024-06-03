export PATH=$PATH:$HOME/scripts

lsc() {
    local script
    script=$(gfind $(echo $PATH | tr ':' ' ') -maxdepth 1 \( -type f -o -type l \) 2>/dev/null | sort | uniq | fzf --reverse --preview 'head -n 200 {}')

    basePath=$(basename "$script")
    if [[ -n $script ]]; then
        print -z "$basePath"
    fi
}

