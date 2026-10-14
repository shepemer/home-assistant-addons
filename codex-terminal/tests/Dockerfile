FROM alpine:3.21

RUN apk add --no-cache bash python3 uv
COPY ha-mcp-requirements.txt /tmp/ha-mcp-requirements.txt
RUN uv venv --python /usr/bin/python3 /opt/ha-mcp && \
    uv pip sync --python /opt/ha-mcp/bin/python --require-hashes \
        --only-binary :all: /tmp/ha-mcp-requirements.txt

# Seed the old per-client launcher with the same dependency versions as HTTP,
# so the benchmark measures sharing rather than a dependency-version change.
RUN uvx --index-strategy unsafe-best-match --from ha-mcp==3.5.1 \
        python -c "import sys; print(sys.executable)" > /tmp/baseline-python && \
    uv pip sync --python "$(cat /tmp/baseline-python)" --require-hashes \
        --only-binary :all: /tmp/ha-mcp-requirements.txt

WORKDIR /work
CMD ["/opt/ha-mcp/bin/python", "-m", "unittest", "discover", "-s", "tests", "-v"]
