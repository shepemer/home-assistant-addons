FROM influxdb:1.13.1@sha256:08c8d90702423fdc7e19e90b89b828772404f571e44abbd113880ab85ca47e1f

USER root

ARG BUILD_VERSION
ARG BUILD_ARCH
LABEL \
    io.hass.version="${BUILD_VERSION}" \
    io.hass.type="app" \
    io.hass.arch="${BUILD_ARCH}" \
    org.opencontainers.image.title="Home Assistant App: InfluxDB" \
    org.opencontainers.image.description="InfluxDB OSS 1.x with private Supervisor storage" \
    org.opencontainers.image.source="https://github.com/shepemer/home-assistant-addons" \
    org.opencontainers.image.licenses="MIT"

RUN apt-get update && \
    apt-get install -y --no-install-recommends jq util-linux && \
    rm -rf /var/lib/apt/lists/*

COPY influxdb.conf /etc/influxdb/influxdb.conf
COPY run.sh /run.sh
RUN chmod 0755 /run.sh

# Replace upstream auto-initialization; it does not provide our bootstrap isolation.
ENTRYPOINT ["/run.sh"]
CMD []
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
    CMD curl --fail --silent --max-time 4 http://127.0.0.1:8086/ping > /dev/null || exit 1
