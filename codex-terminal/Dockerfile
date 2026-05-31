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

ARG CODEX_VERSION=latest

RUN npm install -g @openai/codex@${CODEX_VERSION} && \
    npm cache clean --force

RUN mkdir -p /config /root && \
    ln -sf /usr/bin/bwrap /usr/local/bin/bwrap && \
    ln -sf /usr/bin/bwrap /usr/local/bin/bubblewrap

ENV NPM_CONFIG_PREFIX=/data/.npm-global
ENV PATH=/data/.npm-global/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

COPY run.sh /run.sh
RUN chmod +x /run.sh

CMD ["/run.sh"]
