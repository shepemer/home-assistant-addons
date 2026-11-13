import type { RequestHandler } from "express";

function isLocalHost(host: string | undefined) {
  return host !== undefined && /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(host);
}

function isLocalOrigin(origin: string | undefined) {
  if (origin === undefined) {
    return true;
  }

  try {
    const url = new URL(origin);
    return (url.protocol === "http:" || url.protocol === "https:") &&
      url.origin === origin && isLocalHost(url.host);
  } catch {
    return false;
  }
}

export const requireLocalAccess: RequestHandler = (req, res, next) => {
  // A loopback listener still needs a Host check to prevent DNS rebinding.
  if (!isLocalHost(req.get("host")) || !isLocalOrigin(req.get("origin"))) {
    res.status(403).json({ error: "Local access required" });
    return;
  }

  next();
};

export const requireIngress: RequestHandler = (req, res, next) => {
  // Authenticate the connection peer, never client-controlled proxy headers.
  const peer = req.socket.remoteAddress;
  if (peer !== "172.30.32.2" && peer !== "::ffff:172.30.32.2") {
    res.status(403).json({ error: "Home Assistant ingress required" });
    return;
  }

  next();
};
