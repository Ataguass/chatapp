import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import type { AuthSessionResponse, DevicePlatform } from "@messaging/contracts";
import { HttpError } from "./service.ts";
import type { AuthContext, Credentials, DeviceDetails, Registration } from "./service.ts";
import type { AuthThrottle } from "./throttle.ts";
import type { AccountLifecycle } from "./account-lifecycle.ts";

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

type AuthorizationRequest = Pick<Request, "get">;

function bearer(req: AuthorizationRequest) {
  const header = req.get("authorization");
  if (!header?.startsWith("Bearer ")) throw new HttpError(401, "unauthorized");
  const token = header.slice(7).trim();
  if (!token || token.length > 128) throw new HttpError(401, "unauthorized");
  return token;
}

export function requireAuth(auth: AuthService) {
  return async (req: AuthorizationRequest, res: Response, next: NextFunction) => {
    try {
      res.locals.auth = await auth.authenticate(bearer(req));
      next();
    } catch (error) {
      next(error);
    }
  };
}

export type AuthControls = {
  throttle: AuthThrottle;
  account: AccountLifecycle;
  revokeSession: (sessionId: string) => void;
  revokeUserSessions: (userId: string) => void;
  accountRemoved: (conversationIds: string[]) => void;
};

export function createAuthRouter(auth: AuthService, controls?: AuthControls) {
  const router = Router();

  async function enforceThrottle(action: Parameters<AuthThrottle>[0], req: Request, res: Response, username: string) {
    const retry = await controls?.throttle(action, req.ip ?? req.socket.remoteAddress ?? "unknown", username);
    if (retry) {
      res.set("Retry-After", String(retry));
      throw new HttpError(429, "auth_rate_limited");
    }
  }

  router.post("/register", async (req, res) => {
    const body = bodyObject(req.body);
    const input: Registration = {
      ...credentials(body),
      displayName: body.displayName === undefined
        ? stringField(body, "username").trim().toLowerCase()
        : stringField(body, "displayName"),
    };
    await enforceThrottle("register", req, res, input.username);
    res.status(201).json(await auth.register(input));
  });

  router.post("/login", async (req, res) => {
    const input = credentials(req.body);
    await enforceThrottle("login", req, res, input.username);
    res.json(await auth.login(input));
  });

  router.post("/refresh", async (req, res) => {
    const body = bodyObject(req.body);
    res.json(await auth.refresh(stringField(body, "refreshToken")));
  });

  router.get("/me", requireAuth(auth), (req, res) => {
    res.json((res.locals as { auth: AuthContext }).auth.user);
  });

  router.post("/logout", requireAuth(auth), async (_req, res) => {
    const context = (res.locals as { auth: AuthContext }).auth;
    await auth.logout(context);
    controls?.revokeSession(context.sessionId);
    res.status(204).end();
  });

  router.post("/logout-all", requireAuth(auth), async (_req, res) => {
    const context = (res.locals as { auth: AuthContext }).auth;
    await auth.logoutAll(context.user.id);
    controls?.revokeUserSessions(context.user.id);
    res.status(204).end();
  });

  if (controls) {
    router.post("/password", requireAuth(auth), async (req, res) => {
      const context = (res.locals as { auth: AuthContext }).auth;
      await enforceThrottle("account_change", req, res, context.user.username);
      const body = bodyObject(req.body);
      await controls.account.changePassword(context, stringField(body, "currentPassword"), stringField(body, "newPassword"));
      controls.revokeUserSessions(context.user.id);
      res.status(204).end();
    });

    router.post("/recovery-codes", requireAuth(auth), async (req, res) => {
      const context = (res.locals as { auth: AuthContext }).auth;
      await enforceThrottle("account_change", req, res, context.user.username);
      const password = stringField(bodyObject(req.body), "password");
      res.json({ codes: await controls.account.replaceRecoveryCodes(context, password) });
    });

    router.post("/password-reset", async (req, res) => {
      const body = bodyObject(req.body);
      const username = stringField(body, "username");
      await enforceThrottle("recover", req, res, username);
      const userId = await controls.account.resetPassword(username, stringField(body, "code"), stringField(body, "password"));
      controls.revokeUserSessions(userId);
      res.status(204).end();
    });

    router.delete("/account", requireAuth(auth), async (req, res) => {
      const context = (res.locals as { auth: AuthContext }).auth;
      const body = bodyObject(req.body);
      await enforceThrottle("account_change", req, res, context.user.username);
      const affected = await controls.account.deleteAccount(context, stringField(body, "username"), stringField(body, "password"));
      controls.revokeUserSessions(context.user.id);
      controls.accountRemoved(affected);
      res.status(204).end();
    });
  }

  return router;
}
