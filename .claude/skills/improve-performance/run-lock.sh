#!/bin/sh
# One /improve-performance run at a time per checkout. A scheduled run can fire while an earlier one is
# still working; two agents in one working tree overwrite each other.
#
#   run-lock.sh acquire        take the lock, or exit 1 naming the run that holds it
#   run-lock.sh release        drop the lock if this session holds it
#   run-lock.sh release --force   drop it whoever holds it (manual mode, on Ross's say-so)
#   run-lock.sh status         print who holds it, if anyone
#
# The holder is the Claude Code process this shell runs under. A lock is stale, and taken over,
# when that process has exited or the lock is older than MAX_AGE_MINUTES, 8.5 hours (a session
# left open after a run that never released it).
set -eu

MAX_AGE_MINUTES=${RUN_LOCK_MAX_AGE_MINUTES:-510}
lock="$(git rev-parse --git-common-dir)/improve-performance-run.lock"

# Nearest ancestor that is a Claude Code process; falls back to the parent shell's parent.
owner() {
    p=$$
    while [ "$p" -gt 1 ]; do
        case "$(ps -o comm= -p "$p" 2>/dev/null)" in
        */claude | claude) echo "$p"; return ;;
        esac
        p=$(ps -o ppid= -p "$p" | tr -d ' ')
    done
    ps -o ppid= -p "$PPID" | tr -d ' '
}

now=$(date +%s)
me=$(owner)

# Prints "pid started" of a live, fresh lock held by someone else; nothing otherwise.
holder() {
    [ -f "$lock" ] || return 0
    read -r pid started <"$lock" || return 0
    [ -n "${pid:-}" ] && [ -n "${started:-}" ] || return 0
    [ "$pid" != "$me" ] || return 0
    kill -0 "$pid" 2>/dev/null || ps -p "$pid" >/dev/null 2>&1 || return 0
    [ $((now - started)) -lt $((MAX_AGE_MINUTES * 60)) ] || return 0
    echo "$pid $started"
}

describe() {
    set -- $1
    echo "another /improve-performance run holds the lock: process $1 since $(date -r "$2" '+%Y-%m-%d %H:%M') ($(( (now - $2) / 60 )) min)"
}

case "${1:-}" in
acquire)
    h=$(holder)
    if [ -n "$h" ]; then
        describe "$h" >&2
        exit 1
    fi
    # Stale or ours: replace it. Noclobber makes the create fail if another run won the race.
    rm -f "$lock"
    if ! (set -C; echo "$me $now" >"$lock") 2>/dev/null; then
        echo "another /improve-performance run took the lock at the same moment" >&2
        exit 1
    fi
    echo "lock taken: process $me"
    ;;
release)
    if [ "${2:-}" = "--force" ]; then
        rm -f "$lock"
        echo "lock released (forced)"
    elif [ -f "$lock" ] && read -r pid _ <"$lock" && [ "$pid" = "$me" ]; then
        rm -f "$lock"
        echo "lock released"
    else
        echo "lock not held by this session; left alone"
    fi
    ;;
status)
    h=$(holder)
    if [ -n "$h" ]; then describe "$h"; else echo "free (or held by this session)"; fi
    ;;
*)
    echo "usage: $0 acquire | release [--force] | status" >&2
    exit 2
    ;;
esac
