import express, { type NextFunction, type Request, type Response } from "express";
import { once } from "node:events";
import { request, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { requireIngress, requireLocalAccess } from "../src/ingress.js";

describe("Local development access", () => {
  it.each([
    { host: "127.0.0.1:8099", origin: undefined, status: 200 },
    { host: "localhost:8099", origin: "http://localhost:5173", status: 200 },
    { host: "127.0.0.1:5173", origin: "http://127.0.0.1:5173", status: 200 },
    { host: "[::1]:8099", origin: "http://[::1]:5173", status: 200 },
    { host: "untrusted.example", origin: undefined, status: 403 },
    { host: "untrusted.example", origin: "http://untrusted.example", status: 403 },
    { host: "localhost.untrusted.example", origin: undefined, status: 403 },
    { host: "127.0.0.1:8099", origin: "https://untrusted.example", status: 403 },
    { host: "127.0.0.1:8099", origin: "null", status: 403 },
    { host: "localhost:8099", origin: "http://untrusted.example@localhost:5173", status: 403 },
    { host: "localhost:8099", origin: "http://localhost:5173/untrusted", status: 403 }
  ])("checks the actual Host and Origin: %j", async ({ host, origin, status }) => {
    const app = express();
    app.set("trust proxy", true);
    app.use(requireLocalAccess);
    app.get("/api/config", (_req, res) => res.json({ configured: false }));
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");

    try {
      const { port } = server.address() as AddressInfo;
      const response = await new Promise<IncomingMessage>((resolve, reject) => {
        const req = request(`http://127.0.0.1:${port}/api/config`, {
          headers: {
            Host: host,
            "X-Forwarded-Host": "localhost:8099",
            ...(origin === undefined ? {} : { Origin: origin })
          }
        }, resolve);
        req.on("error", reject);
        req.end();
      });
      response.resume();

      expect(response.statusCode).toBe(status);
      expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});

describe("Home Assistant ingress access", () => {
  it.each(["172.30.32.2", "::ffff:172.30.32.2"])("accepts the Supervisor peer %s", (remoteAddress) => {
    const next = vi.fn();
    const response = { status: vi.fn() };

    requireIngress(
      { socket: { remoteAddress } } as Request,
      response as unknown as Response,
      next as NextFunction
    );

    expect(next).toHaveBeenCalledOnce();
    expect(response.status).not.toHaveBeenCalled();
  });

  it.each([undefined, "127.0.0.1", "::1", "172.30.32.3", "172.30.33.2", "192.168.1.2"])(
    "denies an untrusted or missing peer %s",
    (remoteAddress) => {
      const next = vi.fn();
      const response = { status: vi.fn().mockReturnThis(), json: vi.fn() };

      requireIngress(
        { socket: { remoteAddress } } as Request,
        response as unknown as Response,
        next as NextFunction
      );

      expect(response.status).toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();
    }
  );

  it("rejects requests that spoof ingress and forwarded headers", async () => {
    const app = express();
    // Even an enabled proxy setting must not turn a forged header into access.
    app.set("trust proxy", true);
    app.use(requireIngress);
    const handler = vi.fn((_req: Request, res: Response) => res.json({ secret: "history" }));
    app.get("/api/signals", handler);
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");

    try {
      const { port } = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${port}/api/signals`, {
        headers: {
          "X-Forwarded-For": "172.30.32.2",
          "X-Real-IP": "172.30.32.2",
          "X-Ingress-Path": "/api/hassio_ingress/forged",
          "X-Remote-User-Id": "admin",
          Origin: "https://untrusted.example"
        }
      });

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "Home Assistant ingress required" });
      expect(response.headers.has("Access-Control-Allow-Origin")).toBe(false);
      expect(handler).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
