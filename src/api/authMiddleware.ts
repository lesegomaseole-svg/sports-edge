/**
 * Shared-secret gate for the whole app (added 2026-08-05, Oracle deployment
 * prep) — this is a single-user advisory tool, not a multi-tenant service,
 * so one shared secret rather than real user accounts is the right amount
 * of protection: the goal is keeping the public internet out, not managing
 * identity.
 *
 * HTTP Basic Auth specifically (not a custom header/token) because it's
 * the one auth mechanism a browser handles natively — the dashboard's own
 * fetch() calls (public/index.html) need zero changes, since the browser
 * caches the credential once entered and resends it on every same-origin
 * request automatically. This also protects the static HTML/JS itself,
 * not just the API — a custom-header scheme would need the page to have
 * already loaded before it could attach the header to anything.
 *
 * Enforcement is entirely gated on AUTH_SHARED_SECRET being set: unset
 * (the default for local dev, matching how every session before this one
 * ran unauthenticated) means this middleware is a no-op, same as today.
 * Set it (the deployment runbook makes this a mandatory step) and
 * everything — every /api route and the dashboard's static files — starts
 * requiring it. See src/index.ts's startup warning for the belt-and-braces
 * reminder if it's ever deployed without this set.
 */
import { NextFunction, Request, Response } from "express";
import { timingSafeEqual } from "crypto";

function secretsMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  // Length must match before timingSafeEqual (it throws on mismatched
  // lengths) — comparing against a fixed-length buffer first avoids
  // leaking length via a thrown-vs-compared timing difference.
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function authGate(req: Request, res: Response, next: NextFunction) {
  const secret = process.env.AUTH_SHARED_SECRET;
  if (!secret) return next(); // unset = unprotected, see file header

  const header = req.headers.authorization;
  if (header?.startsWith("Basic ")) {
    const decoded = Buffer.from(header.slice("Basic ".length), "base64").toString("utf-8");
    const password = decoded.includes(":") ? decoded.slice(decoded.indexOf(":") + 1) : decoded;
    if (secretsMatch(password, secret)) return next();
  }

  res.setHeader("WWW-Authenticate", 'Basic realm="Sports Edge"');
  res.status(401).json({ error: "Authentication required" });
}
