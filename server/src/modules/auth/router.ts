import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import type { AuthSessionResponse, DevicePlatform } from "@messaging/contracts";
import { HttpError } from "./service.ts";
import type { AuthContext, Credentials, DeviceDetails, Registration } from "./service.ts";

export type AuthService = {
  register(input: Registration): Promise<AuthSessionResponse>;
  login(input: Credentials): Promise<AuthSessionResponse>;
  refresh(token: string): Promise<AuthSessionResponse>;
  authenticate(token: string): Promise<AuthContext>;
  logout(context: AuthContext): Promise<void>;
  logoutAll(userId: string): Promise<void>;
};

function bodyObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "invalid_request");
  }
  return value as Record<string, unknown>;
}

function stringField(body: Record<string, unknown>, name: string) {
  const value = body[name];
  if (typeof value !== "string") throw new HttpError(400, "invalid_request");
  return value;
}

function deviceFields(body: Record<string, unknown>): DeviceDetails {
  const platform = body.platform ?? "web";
  if (platform !== "android" && platform !== "ios" && platform !== "web" && platform !== "desktop") {
    throw new HttpError(400, "invalid_device");
  }
  const deviceName = body.deviceName === undefined ? "Web browser" : stringField(body, "deviceName");
  return { platform: platform as DevicePlatform, deviceName };
}

function credentials(value: unknown): Credentials {
  const body = bodyObject(value);
  return {
    username: stringField(body, "username"),
    password: stringField(body, "password"),
    ...deviceFields(body),
  };
}

function bearer(req: Request) {
  const header = req.get("authorization");
  if (!header?.startsWith("Bearer ")) throw new HttpError(401, "unauthorized");
  const token = header.slice(7).trim();
  if (!token || token.length > 128) throw new HttpError(401, "unauthorized");
  return token;
}

export function requireAuth(auth: AuthService) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.locals.auth = await auth.authenticate(bearer(req));
      next();
    } catch (error) {
      next(error);
    }
  };
}

export function createAuthRouter(auth: AuthService) {
  const router = Router();

  router.post("/register", async (req, res) => {
    const body = bodyObject(req.body);
    const input: Registration = {
      ...credentials(body),
      displayName: body.displayName === undefined
        ? stringField(body, "username").trim().toLowerCase()
        : stringField(body, "displayName"),
    };
    res.status(201).json(await auth.register(input));
  });

  router.post("/login", async (req, res) => {
    res.json(await auth.login(credentials(req.body)));
  });

  router.post("/refresh", async (req, res) => {
    const body = bodyObject(req.body);
    res.json(await auth.refresh(stringField(body, "refreshToken")));
  });

  router.get("/me", requireAuth(auth), (req, res) => {
    res.json((res.locals as { auth: AuthContext }).auth.user);
  });

  router.post("/logout", requireAuth(auth), async (_req, res) => {
    await auth.logout((res.locals as { auth: AuthContext }).auth);
    res.status(204).end();
  });

  router.post("/logout-all", requireAuth(auth), async (_req, res) => {
    const context = (res.locals as { auth: AuthContext }).auth;
    await auth.logoutAll(context.user.id);
    res.status(204).end();
  });

  return router;
}
