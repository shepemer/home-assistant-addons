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
readonly CODEX_INSTALL_TIMEOUT_SECONDS="${CODEX_INSTALL_TIMEOUT_SECONDS:-300}"
readonly STANDALONE_CODEX_BIN="${CODEX_HOME_DIR}/packages/standalone/current/codex"
readonly CODEX_CONFIG_FILE="${CODEX_HOME_DIR}/config.toml"
readonly SSH_DIR="/data/ssh"
readonly SSHD_CONFIG="${SSH_DIR}/sshd_config"
readonly SSH_AUTHORIZED_KEYS="${SSH_DIR}/authorized_keys"

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
        -e 's/(SUPERVISOR_API_TOKEN[=[:space:]:"]+)[^"[:space:]]+/\1<redacted>/g' \
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

log_file_info() {
    local file="$1"
    local prefix="$2"

    [ -s "${file}" ] || return 0
    tail -n 20 "${file}" | redact_log | while IFS= read -r line; do
        bashio::log.info "${prefix}: ${line}"
    done
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

ensure_trusted_project() {
    local project_path="$1"

    if ! grep -F "[projects.\"${project_path}\"]" "${CODEX_CONFIG_FILE}" >/dev/null 2>&1; then
        {
            printf '\n[projects."%s"]\n' "${project_path}"
            printf 'trust_level = "trusted"\n'
        } >>"${CODEX_CONFIG_FILE}"
    fi
}

configure_codex_projects() {
    touch "${CODEX_CONFIG_FILE}"
    if grep -Eq '^managed_dir[[:space:]]*=' "${CODEX_CONFIG_FILE}"; then
        sed -i 's#^managed_dir[[:space:]]*=.*#managed_dir = "/config"#' "${CODEX_CONFIG_FILE}"
    else
        {
            printf '\n'
            printf 'managed_dir = "/config"\n'
        } >>"${CODEX_CONFIG_FILE}"
    fi
    ensure_trusted_project /config
    ensure_trusted_project /addons
    ensure_trusted_project /share
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

configure_ssh() {
    local enable_ssh
    local ssh_keys
    local ssh_username
    local ssh_password
    local password_authentication="no"
    local permit_root_login="prohibit-password"

    enable_ssh="$(bashio::config 'enable_ssh' 'false')"
    [ "${enable_ssh}" = "true" ] || {
        bashio::log.info "SSH access is disabled"
        return 0
    }

    require_command sshd || {
        bashio::log.warning "sshd is required for SSH access"
        return 0
    }
    require_command ssh-keygen || {
        bashio::log.warning "ssh-keygen is required for SSH access"
        return 0
    }

    ssh_username="$(bashio::config 'ssh_username' 'root')"
    ssh_username="${ssh_username:-root}"
    if ! printf '%s\n' "${ssh_username}" | grep -Eq '^[a-z_][a-z0-9_-]{0,31}$'; then
        bashio::log.warning "SSH access is enabled but ssh_username is invalid"
        return 0
    fi

    ssh_password="$(bashio::config 'ssh_password' '')"
    ssh_keys="$(bashio::config 'ssh_authorized_keys' '')"
    if [ -z "${ssh_password}" ] && [ -z "${ssh_keys}" ]; then
        bashio::log.warning "SSH access is enabled but no ssh_password or ssh_authorized_keys are configured"
        return 0
    fi

    mkdir -p "${SSH_DIR}" /run/sshd
    chmod 700 "${SSH_DIR}"

    if [ ! -s "${SSH_DIR}/ssh_host_ed25519_key" ]; then
        ssh-keygen -t ed25519 -f "${SSH_DIR}/ssh_host_ed25519_key" -N "" >/tmp/codex-ssh-keygen.log 2>&1 || {
            bashio::log.warning "Failed to generate ed25519 SSH host key"
            log_tail /tmp/codex-ssh-keygen.log "ssh-keygen"
            return 0
        }
    fi

    if [ ! -s "${SSH_DIR}/ssh_host_ecdsa_key" ]; then
        ssh-keygen -t ecdsa -f "${SSH_DIR}/ssh_host_ecdsa_key" -N "" >/tmp/codex-ssh-keygen.log 2>&1 || {
            bashio::log.warning "Failed to generate ecdsa SSH host key"
            log_tail /tmp/codex-ssh-keygen.log "ssh-keygen"
            return 0
        }
    fi

    chmod 600 "${SSH_DIR}"/ssh_host_*_key
    printf '%s\n' "${ssh_keys}" >"${SSH_AUTHORIZED_KEYS}"
    chmod 600 "${SSH_AUTHORIZED_KEYS}"

    if [ "${ssh_username}" != "root" ]; then
        if grep -qE "^${ssh_username}:" /etc/passwd; then
            sed -i "s|^${ssh_username}:.*|${ssh_username}:x:0:0:root:/root:/bin/bash|" /etc/passwd
        else
            printf '%s:x:0:0:root:/root:/bin/bash\n' "${ssh_username}" >>/etc/passwd
        fi

        if [ -f /etc/shadow ]; then
            if grep -qE "^${ssh_username}:" /etc/shadow; then
                sed -i "s|^${ssh_username}:.*|${ssh_username}:!:19000:0:99999:7:::|" /etc/shadow
            else
                printf '%s:!:19000:0:99999:7:::\n' "${ssh_username}" >>/etc/shadow
            fi
        fi
    fi

    if [ -n "${ssh_password}" ]; then
        require_command chpasswd || {
            bashio::log.warning "chpasswd is required for SSH password access"
            return 0
        }
        printf '%s:%s\n' "${ssh_username}" "${ssh_password}" | chpasswd >/tmp/codex-ssh-passwd.log 2>&1 || {
            bashio::log.warning "Failed to configure SSH password"
            log_tail /tmp/codex-ssh-passwd.log "chpasswd"
            return 0
        }
        password_authentication="yes"
        permit_root_login="yes"
    fi

    cat >"${SSHD_CONFIG}" <<EOF
Port 2222
ListenAddress 0.0.0.0
Protocol 2
HostKey ${SSH_DIR}/ssh_host_ed25519_key
HostKey ${SSH_DIR}/ssh_host_ecdsa_key
AuthorizedKeysFile ${SSH_AUTHORIZED_KEYS}
PermitRootLogin ${permit_root_login}
PubkeyAuthentication yes
PasswordAuthentication ${password_authentication}
KbdInteractiveAuthentication no
ChallengeResponseAuthentication no
PermitEmptyPasswords no
AllowTcpForwarding no
X11Forwarding no
PermitTTY yes
PermitUserEnvironment no
UsePAM no
PrintMotd no
Subsystem sftp internal-sftp
SetEnv HOME=${HOME} CODEX_HOME=${CODEX_HOME} XDG_CONFIG_HOME=${XDG_CONFIG_HOME} XDG_DATA_HOME=${XDG_DATA_HOME} XDG_CACHE_HOME=${XDG_CACHE_HOME} NPM_CONFIG_PREFIX=${NPM_CONFIG_PREFIX} PATH=${CODEX_RUNTIME_PATH}
EOF

    if ! sshd -t -f "${SSHD_CONFIG}" >/tmp/codex-sshd-check.log 2>&1; then
        bashio::log.warning "SSH configuration validation failed; SSH access skipped"
        log_tail /tmp/codex-sshd-check.log "sshd"
        return 0
    fi

    if pgrep -x sshd >/dev/null 2>&1; then
        bashio::log.info "Stopping existing sshd process"
        pkill -x sshd || true
    fi

    if /usr/sbin/sshd -f "${SSHD_CONFIG}" -E /tmp/codex-sshd.log; then
        bashio::log.info "SSH access started on container port 2222"
    else
        bashio::log.warning "Failed to start SSH access"
        log_tail /tmp/codex-sshd.log "sshd"
    fi
}

codex_login_available() {
    [ -n "${CODEX_BIN}" ] && [ -x "${CODEX_BIN}" ] || return 1
    "${CODEX_BIN}" login status >/tmp/codex-login-status.log 2>&1
}

install_standalone_codex() {
    local installer="/tmp/codex-install.sh"

    bashio::log.info "Installing standalone Codex for remote-control..."
    if ! run_with_timeout "${CODEX_INSTALL_TIMEOUT_SECONDS}" \
        curl -fsSL https://chatgpt.com/codex/install.sh -o "${installer}" >/tmp/codex-standalone-install.log 2>&1; then
        bashio::log.warning "Standalone Codex installer download failed"
        log_tail /tmp/codex-standalone-install.log "codex install"
        return 1
    fi

    if ! run_with_timeout "${CODEX_INSTALL_TIMEOUT_SECONDS}" \
        sh "${installer}" >>/tmp/codex-standalone-install.log 2>&1; then
        bashio::log.warning "Standalone Codex installer failed"
        log_tail /tmp/codex-standalone-install.log "codex install"
        return 1
    fi

    if [ ! -x "${STANDALONE_CODEX_BIN}" ]; then
        bashio::log.warning "Standalone Codex install did not create ${STANDALONE_CODEX_BIN}"
        log_tail /tmp/codex-standalone-install.log "codex install"
        return 1
    fi
}

log_app_server_daemon_files() {
    local daemon_dir="${CODEX_HOME}/app-server-daemon"
    local file

    [ -d "${daemon_dir}" ] || return 0

    find "${daemon_dir}" -maxdepth 2 -type f -print >/tmp/codex-app-server-daemon-files.log 2>/dev/null || true
    log_tail /tmp/codex-app-server-daemon-files.log "app-server-daemon file"

    for file in "${daemon_dir}"/*; do
        [ -f "${file}" ] || continue
        log_tail "${file}" "app-server-daemon $(basename "${file}")"
    done
}

start_remote_control_daemon() {
    if "${STANDALONE_CODEX_BIN}" app-server daemon bootstrap --help >/dev/null 2>&1; then
        "${STANDALONE_CODEX_BIN}" app-server daemon stop >/tmp/codex-remote-control-stop.log 2>&1 || true
        cd /config
        pwd >/tmp/codex-remote-control-cwd.log
        "${STANDALONE_CODEX_BIN}" app-server -c 'managed_dir="/config"' daemon bootstrap --remote-control \
            >/tmp/codex-remote-control-start.log 2>&1
    else
        "${STANDALONE_CODEX_BIN}" remote-control stop >/tmp/codex-remote-control-stop.log 2>&1 || true
        cd /config
        pwd >/tmp/codex-remote-control-cwd.log
        "${STANDALONE_CODEX_BIN}" remote-control start -c 'managed_dir="/config"' --json \
            >/tmp/codex-remote-control-start.log 2>&1
    fi
}

configure_remote_control() {
    local enable_remote_control

    enable_remote_control="$(bashio::config 'enable_remote_control' 'false')"
    [ "${enable_remote_control}" = "true" ] || {
        bashio::log.info "Codex remote-control is disabled"
        return 0
    }

    if ! codex_login_available; then
        bashio::log.warning "Codex remote-control requires Codex auth; run codex login from the terminal first"
        log_tail /tmp/codex-login-status.log "codex login status"
        return 0
    fi

    if [ ! -x "${STANDALONE_CODEX_BIN}" ] && ! install_standalone_codex; then
        bashio::log.warning "Codex remote-control skipped because standalone Codex is unavailable"
        return 0
    fi

    if start_remote_control_daemon; then
        bashio::log.info "Codex remote-control daemon started"
        log_file_info /tmp/codex-remote-control-cwd.log "codex remote-control cwd"
        log_file_info /tmp/codex-remote-control-start.log "codex remote-control"
    else
        bashio::log.warning "Codex remote-control failed to start"
        log_tail /tmp/codex-remote-control-cwd.log "codex remote-control cwd"
        log_tail /tmp/codex-remote-control-start.log "codex remote-control"
        log_app_server_daemon_files
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
configure_codex_projects
select_codex
check_bubblewrap
if ! configure_ha_mcp; then
    bashio::log.warning "Home Assistant MCP integration failed unexpectedly; continuing without MCP"
fi
if ! run_user_startup_script; then
    bashio::log.warning "Startup package hook failed unexpectedly; continuing with terminal startup"
fi
if ! configure_ssh; then
    bashio::log.warning "SSH setup failed unexpectedly; continuing without SSH"
fi
if ! configure_remote_control; then
    bashio::log.warning "Codex remote-control setup failed unexpectedly; continuing without remote-control"
fi
configure_tmux_session

bashio::log.info "Starting web terminal on port 7681"
exec ttyd \
    --port 7681 \
    --writable \
    --max-clients 5 \
    tmux attach-session -t "${SESSION_NAME}"
