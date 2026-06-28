# shellcheck shell=sh

codex_terminal_env_file="/run/codex-terminal/codex-env.sh"

if [ -r "${codex_terminal_env_file}" ]; then
    # shellcheck source=/dev/null
    . "${codex_terminal_env_file}"
fi

unset codex_terminal_env_file
