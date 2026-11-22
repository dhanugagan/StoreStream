import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { UserRole } from '../shared/types/storestream.ts';

// Ephemeral fallback ensures no secret is ever hardcoded if JWT_SECRET env var is unset
const EPHEMERAL_JWT_SECRET = crypto.randomBytes(32).toString('hex');

function getJwtSecret(): string {
  const configured = process.env.JWT_SECRET?.trim();
  return configured && configured.length >= 16 ? configured : EPHEMERAL_JWT_SECRET;
}

export interface JwtClaims {
  sub: string;
  email: string;
  name: string;
  role: UserRole;
  iat: number;
  exp: number;
}

export interface AuthenticatedRequest extends Request {
  authUser?: JwtClaims;
}

export function hashPassword(plain: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(plain, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

export function verifyPassword(plain: string, storedHash: string): boolean {
  const parts = storedHash.split(':');
  if (parts.length !== 2) return false;
  const [salt, hashHex] = parts;
  if (!salt || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(plain, salt, 64);
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}

function base64UrlEncode(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

function base64UrlDecode(input: string): string {
  return Buffer.from(input, 'base64url').toString('utf8');
}

export function signJwt(payload: Omit<JwtClaims, 'iat' | 'exp'>, ttlSeconds = 86400): string {
  const now = Math.floor(Date.now() / 1000);
  const claims: JwtClaims = {
    ...payload,
    iat: now,
    exp: now + ttlSeconds,
  };
  const headerB64 = base64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payloadB64 = base64UrlEncode(JSON.stringify(claims));
  const signingInput = `${headerB64}.${payloadB64}`;
  const sig = crypto
    .createHmac('sha256', getJwtSecret())
    .update(signingInput)
    .digest('base64url');
  return `${signingInput}.${sig}`;
}

export function verifyJwt(token: string): JwtClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts;
  const signingInput = `${headerB64}.${payloadB64}`;
  const expectedSig = crypto
    .createHmac('sha256', getJwtSecret())
    .update(signingInput)
    .digest('base64url');

  const sigBuf = Buffer.from(sigB64);
  const expBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }

  try {
    const parsed = JSON.parse(base64UrlDecode(payloadB64)) as JwtClaims;
    if (!parsed.sub || !parsed.role || parsed.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function optionalAuth(req: AuthenticatedRequest, _res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    const claims = verifyJwt(token);
    if (claims) {
      req.authUser = claims;
    }
  }
  next();
}

export function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authentication required.' });
    return;
  }
  const claims = verifyJwt(authHeader.slice(7).trim());
  if (!claims) {
    res.status(401).json({ error: 'Invalid or expired session token.' });
    return;
  }
  req.authUser = claims;
  next();
}

export function requireRoles(...allowed: UserRole[]) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    if (!req.authUser) {
      res.status(401).json({ error: 'Authentication required.' });
      return;
    }
    if (!allowed.includes(req.authUser.role)) {
      res.status(403).json({
        error: `Access denied. Required role: ${allowed.join(' or ')}.`,
      });
      return;
    }
    next();
  };
}

export function securityHeadersMiddleware(req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-XSS-Protection', '0');

  const allowedOrigin = process.env.FRONTEND_URL?.trim();
  const origin = req.headers.origin;
  if (origin && allowedOrigin && origin === allowedOrigin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,Idempotency-Key');
    res.status(204).end();
    return;
  }
  next();
}

export function createRateLimiter(maxRequests: number, windowMs: number) {
  const hits = new Map<string, number[]>();
  return (req: Request, res: Response, next: NextFunction): void => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const cutoff = now - windowMs;
    const recent = (hits.get(ip) || []).filter((t) => t > cutoff);
    if (recent.length >= maxRequests) {
      res.status(429).json({ error: 'Too many requests. Please slow down and retry.' });
      return;
    }
    recent.push(now);
    hits.set(ip, recent);
    next();
  };
}

export function sanitizeImageUrl(url: string): string {
  const trimmed = url.trim();
  if (trimmed.startsWith('/src/assets/images/') || trimmed.startsWith('/uploads/')) {
    return trimmed;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
      return parsed.toString();
    }
  } catch {
    // Fall back safely
  }
  return '/src/assets/images/product_bluetooth_earphones_1795314720308.jpg';
}
