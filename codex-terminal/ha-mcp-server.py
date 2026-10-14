#!/opt/ha-mcp/bin/python
"""Serve the existing HA MCP tool registry once, on container loopback only."""

import asyncio
from contextlib import asynccontextmanager
import http.client
import json
import os
import sys

HOST = "127.0.0.1"
PORT = 8765
MCP_PATH = "/mcp"
HEALTH_PATH = "/healthz"
HEALTH_BODY = {"service": "codex-terminal-ha-mcp", "ready": True}


class RedactedStream:
    """Keep the HA credential out of dependency logs and exception messages."""

    def __init__(self, stream, secret):
        self.stream = stream
        self.secret = secret

    def write(self, value):
        return self.stream.write(value.replace(self.secret, "[REDACTED]"))

    def __getattr__(self, name):
        return getattr(self.stream, name)


def check_ready():
    """Probe without importing MCP, creating a client session, or using proxies."""
    connection = http.client.HTTPConnection(HOST, PORT, timeout=2)
    try:
        connection.request("GET", HEALTH_PATH)
        response = connection.getresponse()
        return response.status == 200 and json.loads(response.read(1024)) == HEALTH_BODY
    except (OSError, ValueError, http.client.HTTPException):
        return False
    finally:
        connection.close()


async def serve():
    # Import after installing log redaction and only in the long-lived process.
    from ha_mcp.server import HomeAssistantSmartMCPServer
    from starlette.responses import JSONResponse
    import uvicorn

    server = HomeAssistantSmartMCPServer()

    @server.mcp.custom_route(HEALTH_PATH, methods=["GET"])
    async def health(_request):
        # Uvicorn accepts requests after the MCP application lifespan has started.
        return JSONResponse(HEALTH_BODY)

    app = server.mcp.http_app(
        transport="streamable-http", path=MCP_PATH, stateless_http=False
    )
    mcp_lifespan = app.router.lifespan_context

    @asynccontextmanager
    async def lifespan(application):
        try:
            async with mcp_lifespan(application):
                yield
        finally:
            # Close HA connections inside ASGI shutdown: Uvicorn replays SIGTERM
            # after shutdown, before its serve() call can return to a finally.
            await server.close()

    app.router.lifespan_context = lifespan
    await uvicorn.Server(
        uvicorn.Config(
            app,
            host=HOST,
            port=PORT,
            lifespan="on",
            access_log=False,
            log_level="error",
            timeout_graceful_shutdown=5,
        )
    ).serve()


def main():
    if sys.argv[1:] == ["--check"]:
        return 0 if check_ready() else 1
    if sys.argv[1:]:
        print("Usage: ha-mcp-server.py [--check]", file=sys.stderr)
        return 2

    secret = os.environ.get("HOMEASSISTANT_TOKEN", "")
    if secret:
        sys.stdout = RedactedStream(sys.stdout, secret)
        sys.stderr = RedactedStream(sys.stderr, secret)

    os.environ["FASTMCP_SHOW_SERVER_BANNER"] = "false"
    os.environ["FASTMCP_LOG_LEVEL"] = "ERROR"
    os.environ["FASTMCP_ENABLE_RICH_LOGGING"] = "false"
    os.environ["FASTMCP_CHECK_FOR_UPDATES"] = "off"
    try:
        asyncio.run(serve())
    except KeyboardInterrupt:
        pass
    except Exception as error:
        # Settings validation can include supplied credentials in its details.
        print(f"HA MCP server failed ({type(error).__name__})", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
