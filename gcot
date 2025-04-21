#!/bin/bash -eux

SELECTED_BRANCH=$(git branch -r | sed -e 's! *origin/!!g' -e '/HEAD/d' | fzf --height=40% --layout=reverse | xargs)
if [[ -n $SELECTED_BRANCH ]]; then
    git checkout "$SELECTED_BRANCH"
fi
