FROM ghcr.io/home-assistant/base:3.21

ARG BUILD_VERSION
ARG BUILD_ARCH
LABEL \
    io.hass.version="${BUILD_VERSION}" \
    io.hass.type="app" \
    io.hass.arch="${BUILD_ARCH}" \
    org.opencontainers.image.title="Home Assistant Add-on: Codex Terminal" \
    org.opencontainers.image.description="Terminal interface for the OpenAI Codex CLI" \
    org.opencontainers.image.source="https://github.com/shepemer/home-assistant-addons" \
    org.opencontainers.image.licenses="MIT"

RUN apk add --no-cache \
    bash \
    bubblewrap \
    curl \
    nodejs \
    npm \
    openssh-server \
    procps \
    python3 \
    py3-pip \
    git \
    tmux \
    ttyd \
    uv \
    ripgrep \
    chromium \
    chromium-chromedriver

RUN python3 -m pip install --break-system-packages --no-cache-dir selenium

# Resolve and download at build time only. No uv/uvx process or cache path is
# needed by the shared connector at runtime; every dependency is hash-locked.
# The HA base's extra wheel index is incomplete for this lock; use only PyPI.
COPY ha-mcp-requirements.txt /opt/ha-mcp-requirements.txt
RUN uv venv --python /usr/bin/python3 /opt/ha-mcp && \
    env -u UV_EXTRA_INDEX_URL -u PIP_EXTRA_INDEX_URL uv --no-config pip sync \
        --index-url https://pypi.org/simple \
        --python /opt/ha-mcp/bin/python --require-hashes \
        --only-binary :all: /opt/ha-mcp-requirements.txt && \
    uv cache clean

RUN curl -fsSL \
        "https://github.com/home-assistant/cli/releases/latest/download/ha_${BUILD_ARCH}" \
        -o /usr/local/bin/ha-cli && \
    chmod +x /usr/local/bin/ha-cli

ARG CODEX_VERSION=latest

RUN npm install -g @openai/codex@${CODEX_VERSION} && \
    npm cache clean --force

RUN mkdir -p /config /root /etc/profile.d && \
    ln -sf /usr/bin/bwrap /usr/local/bin/bwrap && \
    ln -sf /usr/bin/bwrap /usr/local/bin/bubblewrap

ENV NPM_CONFIG_PREFIX=/data/.npm-global
ENV PATH=/data/.npm-global/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
# Allow the shared HTTP service to drain SSE connections before s6 forces exit.
ENV S6_SERVICES_GRACETIME=15000
# run.sh enables the initially-down connector after migrating its credentials,
# then performs readiness checks before starting Codex clients.
ENV S6_CMD_WAIT_FOR_SERVICES=0

COPY codex-terminal-shell /usr/local/bin/codex-terminal-shell
COPY codex-terminal-profile.sh /etc/profile.d/codex-terminal.sh
COPY run.sh /run.sh
COPY ha /usr/local/bin/ha
COPY ha-mcp-server.py ha-mcp-config.py /usr/local/libexec/
COPY services.d/ha-mcp /etc/services.d/ha-mcp
RUN chmod +x /run.sh /usr/local/bin/ha /usr/local/bin/codex-terminal-shell && \
    chmod +x /usr/local/libexec/ha-mcp-server.py /usr/local/libexec/ha-mcp-config.py \
        /etc/services.d/ha-mcp/run /etc/services.d/ha-mcp/finish && \
    chmod 0644 /etc/profile.d/codex-terminal.sh && \
    printf '%s\n' /usr/local/bin/codex-terminal-shell >> /etc/shells

CMD ["/run.sh"]
