/**
 * Shared admin-token auth primitives for the outreach observability surface.
 *
 * Ported from salones-wa/web/auth.ts. ADMIN_TOKEN gates /metrics + /health/session
 * (the /health liveness probe stays public). The timing-safe comparison lives
 * here ONCE so call sites can't drift.
 */

import { timingSafeEqual } from "crypto";
import type { Context } from "hono";

/** Read + validate ADMIN_TOKEN from the environment. Throws if unset/short. */
export function getAdminToken(): string {
  const token = process.env["ADMIN_TOKEN"];
  if (!token)
    throw new Error(
      "[gilda-outreach] ADMIN_TOKEN env var is required but not set",
    );
  if (token.length < 16)
    throw new Error(
      "[gilda-outreach] ADMIN_TOKEN must be at least 16 characters",
    );
  return token;
}

/** Constant-time token comparison to prevent timing attacks. */
export function safeTokenCompare(a: string, b: string): boolean {
  if (a.length !== b.length) {
    // Dummy compare to avoid a length-based timing leak.
    timingSafeEqual(Buffer.from(a), Buffer.alloc(a.length));
    return false;
  }
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * Gate a request on the admin token passed as `?token=`. Returns true only on an
 * exact, constant-time match. Returns false (never throws) when the token is
 * missing/wrong OR the server is misconfigured (no ADMIN_TOKEN).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function verifyAdminTokenQuery(c: Context<any, any, any>): boolean {
  const token = c.req.query("token") ?? "";
  let adminToken: string;
  try {
    adminToken = getAdminToken();
  } catch {
    return false;
  }
  return safeTokenCompare(token, adminToken);
}

/** Best-effort client IP for per-IP rate limiting (first X-Forwarded-For hop). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function clientIp(c: Context<any, any, any>): string {
  return c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
}

export interface RateLimiter {
  /** Returns false when the IP is over the failure budget for this window. */
  check(ip: string): boolean;
  /** Record a failed auth attempt against the IP. */
  recordFailure(ip: string): void;
}

/**
 * Per-IP brute-force limiter (in-memory, resets on restart). Only FAILED
 * attempts are counted, so a correctly-configured Prometheus scraper never
 * trips it.
 */
export function createRateLimiter(
  maxAttempts = 5,
  windowMs = 60_000,
): RateLimiter {
  const attempts = new Map<string, { count: number; resetAt: number }>();
  return {
    check(ip: string): boolean {
      const now = Date.now();
      const record = attempts.get(ip);
      if (!record || record.resetAt < now) {
        attempts.set(ip, { count: 0, resetAt: now + windowMs });
        return true;
      }
      return record.count < maxAttempts;
    },
    recordFailure(ip: string): void {
      const now = Date.now();
      const record = attempts.get(ip);
      if (!record || record.resetAt < now) {
        attempts.set(ip, { count: 1, resetAt: now + windowMs });
      } else {
        record.count++;
      }
    },
  };
}
