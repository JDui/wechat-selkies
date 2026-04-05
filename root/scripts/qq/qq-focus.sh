#!/bin/bash
set -eu

is_visible_window() {
    local wid="$1"
    xprop -id "$wid" _NET_WM_STATE 2>/dev/null | grep -qv "_NET_WM_STATE_HIDDEN"
}

has_normal_window_type() {
    local wid="$1"
    xprop -id "$wid" _NET_WM_WINDOW_TYPE 2>/dev/null | grep -q "_NET_WM_WINDOW_TYPE_NORMAL"
}

is_transient_window() {
    local wid="$1"
    xprop -id "$wid" WM_TRANSIENT_FOR 2>/dev/null | grep -q "window id #"
}

window_title() {
    local wid="$1"
    xdotool getwindowname "$wid" 2>/dev/null || true
}

search_candidates() {
    {
        xdotool search --onlyvisible --class 'qq' 2>/dev/null || true
        xdotool search --class 'qq' 2>/dev/null || true
        xdotool search --onlyvisible --name 'QQ|腾讯QQ' 2>/dev/null || true
        xdotool search --name 'QQ|腾讯QQ' 2>/dev/null || true
    } | awk '!seen[$0]++'
}

score_window() {
    local wid="$1"
    local title="$2"
    local score=0

    case "$title" in
        "QQ"|"腾讯QQ")
            score=300
            ;;
        *"QQ"*|*"腾讯QQ"*)
            score=180
            ;;
        "")
            score=0
            ;;
        *)
            score=40
            ;;
    esac

    if has_normal_window_type "$wid"; then
        score=$((score + 120))
    fi
    if is_visible_window "$wid"; then
        score=$((score + 80))
    fi
    if is_transient_window "$wid"; then
        score=$((score - 400))
    fi

    echo "$score"
}

find_main_window() {
    local best_wid=""
    local best_score=-999999
    local candidates
    candidates="$(search_candidates)"

    local wid
    for wid in $candidates; do
        local title score
        title="$(window_title "$wid")"
        score="$(score_window "$wid" "$title")"
        if [ "$score" -gt "$best_score" ]; then
            best_score="$score"
            best_wid="$wid"
        fi
    done

    if [ -n "$best_wid" ]; then
        echo "$best_wid"
        return 0
    fi

    return 1
}

wid="$(find_main_window || true)"

if [ -n "$wid" ]; then
    xdotool windowmap "$wid" >/dev/null 2>&1 || true
    xdotool windowraise "$wid" >/dev/null 2>&1 || true
    xdotool windowactivate --sync "$wid" >/dev/null 2>&1 || true
    exit 0
fi

exit 1
