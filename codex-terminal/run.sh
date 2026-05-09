#!/usr/bin/with-contenv bashio

set -e

readonly HOME="/root"
readonly CODEX_VERSION="${CODEX_VERSION:-latest}"
readonly NPM_GLOBAL_PREFIX="/data/.npm-global"
readonly CODEX_HOME_DIR="/data/.codex"
readonly HA_MCP_PACKAGE="ha-mcp==3.5.1"
readonly SESSION_NAME="codex"
readonly NPM_VIEW_TIMEOUT_SECONDS="${NPM_VIEW_TIMEOUT_SECONDS:-30}"
readonly NPM_INSTALL_TIMEOUT_SECONDS="${NPM_INSTALL_TIMEOUT_SECONDS:-300}"

readonly IMAGE_FIRST_PATH="/usr/local/sbin:/usr/local/bin:${NPM_GLOBAL_PREFIX}/bin:/usr/sbin:/usr/bin:/sbin:/bin"
readonly PERSISTENT_FIRST_PATH="${NPM_GLOBAL_PREFIX}/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

export HOME
export XDG_CONFIG_HOME="/data/.config"
export XDG_DATA_HOME="/data/.local/share"
export XDG_CACHE_HOME="/data/.cache"
export NPM_CONFIG_PREFIX="${NPM_GLOBAL_PREFIX}"
export CODEX_HOME="${CODEX_HOME_DIR}"
export PATH="${IMAGE_FIRST_PATH}"

redact_log() {
    sed -E \
        -e 's/(HOMEASSISTANT_TOKEN[=[:space:]:"]+)[^"[:space:]]+/\1<redacted>/g' \
        -e 's/(SUPERVISOR_TOKEN[=[:space:]:"]+)[^"[:space:]]+/\1<redacted>/g' \
        -e 's/(Authorization:[[:space:]]*Bearer )[A-Za-z0-9._-]+/\1<redacted>/Ig' \
        -e 's/(Bearer )[A-Za-z0-9._-]+/\1<redacted>/g'
}

log_tail() {
    local file="$1"
    local prefix="$2"

    [ -s "${file}" ] || return 0
    tail -n 20 "${file}" | redact_log | while IFS= read -r line; do
        bashio::log.warning "${prefix}: ${line}"
    done
}

require_command() {
    local name="$1"

    if ! command -v "${name}" >/dev/null 2>&1; then
        bashio::log.warning "${name} is not available on PATH"
        return 1
    fi
}

run_with_timeout() {
    local timeout_seconds="$1"
    shift

    if command -v timeout >/dev/null 2>&1; then
        timeout "${timeout_seconds}" "$@"
    else
        "$@"
    fi
}

load_supervisor_token() {
    local token_file

    [ -n "${SUPERVISOR_TOKEN:-}" ] && return 0

    for token_file in \
        /run/s6/container_environment/SUPERVISOR_TOKEN \
        /var/run/s6/container_environment/SUPERVISOR_TOKEN; do
        if [ -s "${token_file}" ]; then
            SUPERVISOR_TOKEN="$(cat "${token_file}")"
            export SUPERVISOR_TOKEN
            return 0
        fi
    done

    return 1
}

version_of() {
    local binary="$1"

    [ -x "${binary}" ] || return 0
    "${binary}" --version 2>/dev/null | awk '{print $2}' || true
}

version_gte() {
    local left="$1"
    local right="$2"

    [ -n "${left}" ] && [ -n "${right}" ] || return 1
    [ "$(printf '%s\n%s\n' "${right}" "${left}" | sort -V | tail -n 1)" = "${left}" ]
}

setup_paths() {
    mkdir -p \
        "${HOME}" \
        "${XDG_CONFIG_HOME}" \
        "${XDG_DATA_HOME}" \
        "${XDG_CACHE_HOME}" \
        "${CODEX_HOME}" \
        "${NPM_CONFIG_PREFIX}/bin"

    if [ -d "${HOME}/.codex" ] && [ ! -L "${HOME}/.codex" ]; then
        cp -a "${HOME}/.codex/." "${CODEX_HOME}/" 2>/dev/null || true
        rm -rf "${HOME}/.codex"
    fi

    if [ "$(readlink "${HOME}/.codex" 2>/dev/null || true)" != "${CODEX_HOME}" ]; then
        rm -rf "${HOME}/.codex"
        ln -s "${CODEX_HOME}" "${HOME}/.codex"
    fi

    if [ -x /usr/bin/bwrap ]; then
        ln -sf /usr/bin/bwrap /usr/local/bin/bwrap
        ln -sf /usr/bin/bwrap /usr/local/bin/bubblewrap
    fi

    bashio::log.info "Codex home: ${HOME}/.codex -> ${CODEX_HOME}"

    if [ -s "${CODEX_HOME}/auth.json" ]; then
        bashio::log.info "Codex auth is present"
    else
        bashio::log.info "Codex auth is not configured yet"
    fi

    if [ -d /addons ] && [ -w /addons ]; then
        bashio::log.info "Local add-on sources are mounted at /addons"
    elif [ -d /addons ]; then
        bashio::log.warning "Local add-on sources are mounted at /addons but are not writable"
    else
        bashio::log.warning "Local add-on sources are not mounted at /addons"
    fi
}

select_codex() {
    local image_bin="/usr/local/bin/codex"
    local persistent_bin="${NPM_CONFIG_PREFIX}/bin/codex"
    local image_version
    local persistent_version
    local latest_version
    local desired_version="${CODEX_VERSION}"

    image_version="$(version_of "${image_bin}")"
    persistent_version="$(version_of "${persistent_bin}")"

    if [ "${CODEX_VERSION}" = "latest" ] && command -v npm >/dev/null 2>&1; then
        latest_version="$(run_with_timeout "${NPM_VIEW_TIMEOUT_SECONDS}" npm view @openai/codex dist-tags.latest 2>/tmp/codex-npm-view.log || true)"
        if [ -z "${latest_version}" ]; then
            bashio::log.warning "Codex CLI latest-version lookup failed; using the best available installed CLI"
            log_tail /tmp/codex-npm-view.log "npm"
        fi
        desired_version="${latest_version:-${persistent_version:-${image_version}}}"
    elif [ "${CODEX_VERSION}" = "latest" ]; then
        bashio::log.warning "npm is not available; using the best available installed Codex CLI"
        desired_version="${persistent_version:-${image_version}}"
    fi

    if [ -n "${desired_version}" ] && [ "${persistent_version}" != "${desired_version}" ]; then
        bashio::log.info "Installing Codex CLI ${desired_version}..."
        if command -v npm >/dev/null 2>&1 \
            && run_with_timeout "${NPM_INSTALL_TIMEOUT_SECONDS}" npm install -g "@openai/codex@${desired_version}" >/tmp/codex-npm-install.log 2>&1; then
            persistent_version="$(version_of "${persistent_bin}")"
        else
            bashio::log.warning "Codex CLI install failed; using the best available bundled CLI"
            log_tail /tmp/codex-npm-install.log "npm"
        fi
    fi

    if [ -x "${persistent_bin}" ] && {
        [ ! -x "${image_bin}" ] || version_gte "${persistent_version}" "${image_version}";
    }; then
        CODEX_BIN="${persistent_bin}"
        CODEX_RUNTIME_PATH="${PERSISTENT_FIRST_PATH}"
    elif [ -x "${image_bin}" ]; then
        CODEX_BIN="${image_bin}"
        CODEX_RUNTIME_PATH="${IMAGE_FIRST_PATH}"
    elif command -v codex >/dev/null 2>&1; then
        CODEX_BIN="$(command -v codex)"
        CODEX_RUNTIME_PATH="${PATH}"
    else
        CODEX_BIN=""
        CODEX_RUNTIME_PATH="${IMAGE_FIRST_PATH}"
    fi

    export PATH="${CODEX_RUNTIME_PATH}"

    if [ -n "${CODEX_BIN}" ] && [ -x "${CODEX_BIN}" ]; then
        bashio::log.info "Using $("${CODEX_BIN}" --version 2>/dev/null) from ${CODEX_BIN}"
    else
        bashio::log.warning "Codex CLI is not available"
    fi
}

check_bubblewrap() {
    if ! command -v bwrap >/dev/null 2>&1; then
        bashio::log.warning "bubblewrap/bwrap is not available; Codex will use sandbox bypass"
        return 0
    fi

    if bwrap --ro-bind / / true >/dev/null 2>/tmp/codex-bwrap-probe.log; then
        bashio::log.info "bubblewrap namespace probe succeeded"
    else
        bashio::log.warning "bubblewrap namespace probe failed; Codex will use sandbox bypass"
    fi
}

probe_homeassistant_api() {
    curl -fsS \
        -H "Authorization: Bearer ${SUPERVISOR_TOKEN}" \
        http://supervisor/core/api/ >/tmp/codex-ha-api-probe.log 2>/tmp/codex-ha-api-probe.err
}

configure_ha_mcp() {
    local enable_ha_mcp

    enable_ha_mcp="$(bashio::config 'enable_ha_mcp' 'true')"
    [ "${enable_ha_mcp}" = "true" ] || {
        bashio::log.info "Home Assistant MCP integration is disabled"
        return 0
    }

    if ! load_supervisor_token; then
        bashio::log.warning "SUPERVISOR_TOKEN is not available; Home Assistant MCP integration skipped"
        return 0
    fi

    require_command uvx || {
        bashio::log.warning "uvx is required for Home Assistant MCP integration"
        return 0
    }

    if [ -z "${CODEX_BIN}" ] || [ ! -x "${CODEX_BIN}" ]; then
        bashio::log.warning "Codex CLI is required for Home Assistant MCP integration"
        return 0
    fi

    if probe_homeassistant_api; then
        bashio::log.info "Home Assistant API probe succeeded"
    else
        bashio::log.warning "Home Assistant API probe failed"
        log_tail /tmp/codex-ha-api-probe.err "ha-api"
    fi

    "${CODEX_BIN}" mcp remove home_assistant >/dev/null 2>&1 || true
    if "${CODEX_BIN}" mcp add home_assistant \
        --env HOMEASSISTANT_URL=http://supervisor/core \
        --env HOMEASSISTANT_TOKEN="${SUPERVISOR_TOKEN}" \
        --env FASTMCP_SHOW_SERVER_BANNER=false \
        --env FASTMCP_LOG_LEVEL=ERROR \
        --env FASTMCP_ENABLE_RICH_LOGGING=false \
        --env FASTMCP_CHECK_FOR_UPDATES=off \
        -- uvx --index-strategy unsafe-best-match --from "${HA_MCP_PACKAGE}" python -m ha_mcp >/tmp/codex-mcp-add.log 2>&1; then
        bashio::log.info "Home Assistant MCP server configured"
    else
        bashio::log.warning "Home Assistant MCP server configuration failed"
        log_tail /tmp/codex-mcp-add.log "codex mcp add"
        return 0
    fi

    if "${CODEX_BIN}" mcp get home_assistant >/tmp/codex-mcp-get.log 2>&1 \
        && grep -q "${HA_MCP_PACKAGE}" /tmp/codex-mcp-get.log \
        && grep -q "FASTMCP_SHOW_SERVER_BANNER" /tmp/codex-mcp-get.log; then
        bashio::log.info "Home Assistant MCP config verified"
    else
        bashio::log.warning "Home Assistant MCP config verification failed"
    fi
}

run_user_startup_script() {
    [ -f /data/startup-packages.sh ] || return 0

    bashio::log.info "Running startup-packages.sh..."
    if bash /data/startup-packages.sh >/tmp/codex-startup-packages.log 2>&1; then
        bashio::log.info "startup-packages.sh completed"
    else
        bashio::log.warning "startup-packages.sh failed; continuing with the terminal startup"
        log_tail /tmp/codex-startup-packages.log "startup-packages.sh"
    fi

    return 0
}

configure_tmux_session() {
    local auto_launch
    local tmux_env
    local codex_command

    auto_launch="$(bashio::config 'auto_launch' 'true')"
    tmux_env="export HOME='${HOME}' XDG_CONFIG_HOME='${XDG_CONFIG_HOME}' XDG_DATA_HOME='${XDG_DATA_HOME}' XDG_CACHE_HOME='${XDG_CACHE_HOME}' CODEX_HOME='${CODEX_HOME}' NPM_CONFIG_PREFIX='${NPM_CONFIG_PREFIX}' PATH='${CODEX_RUNTIME_PATH}'"

    if [ -n "${CODEX_BIN}" ] && [ -x "${CODEX_BIN}" ]; then
        codex_command="\"${CODEX_BIN}\" --dangerously-bypass-approvals-and-sandbox"
    else
        codex_command=""
    fi

    cd /config

    if tmux has-session -t "${SESSION_NAME}" 2>/dev/null; then
        if [ "${auto_launch}" = "true" ]; then
            tmux kill-session -t "${SESSION_NAME}"
        else
            tmux send-keys -t "${SESSION_NAME}" "cd /config" Enter
            tmux send-keys -t "${SESSION_NAME}" "${tmux_env}" Enter
            if [ -n "${codex_command}" ]; then
                tmux send-keys -t "${SESSION_NAME}" "alias codex='${CODEX_BIN} --dangerously-bypass-approvals-and-sandbox'" Enter
            else
                bashio::log.warning "Codex CLI is unavailable; not configuring codex alias"
            fi
            return 0
        fi
    fi

    bashio::log.info "Starting Codex tmux session"
    tmux new-session -d -s "${SESSION_NAME}" -x 220 -y 50 bash
    tmux send-keys -t "${SESSION_NAME}" "cd /config" Enter
    tmux send-keys -t "${SESSION_NAME}" "${tmux_env}" Enter
    if [ -n "${codex_command}" ]; then
        tmux send-keys -t "${SESSION_NAME}" "alias codex='${CODEX_BIN} --dangerously-bypass-approvals-and-sandbox'" Enter
    else
        bashio::log.warning "Codex CLI is unavailable; terminal will start without auto-launch"
    fi

    if [ "${auto_launch}" = "true" ] && [ -n "${codex_command}" ]; then
        tmux send-keys -t "${SESSION_NAME}" "${codex_command}" Enter
    fi
}

bashio::log.info "Starting Codex Terminal"

setup_paths
select_codex
check_bubblewrap
if ! configure_ha_mcp; then
    bashio::log.warning "Home Assistant MCP integration failed unexpectedly; continuing without MCP"
fi
if ! run_user_startup_script; then
    bashio::log.warning "Startup package hook failed unexpectedly; continuing with terminal startup"
fi
configure_tmux_session

bashio::log.info "Starting web terminal on port 7681"
exec ttyd \
    --port 7681 \
    --writable \
    --max-clients 5 \
    tmux attach-session -t "${SESSION_NAME}"
