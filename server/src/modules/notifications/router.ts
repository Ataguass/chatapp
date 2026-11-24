import { Router } from "express";
import { requireAuth } from "../auth/router.ts";
import type { AuthService } from "../auth/router.ts";
import type { AuthContext } from "../auth/service.ts";
import { HttpError } from "../auth/service.ts";
import type { NotificationService } from "./service.ts";

export function createNotificationsRouter(auth: AuthService, notifications: NotificationService) {
  const router = Router();
  const authenticated = requireAuth(auth);

  router.get("/preferences", authenticated, async (_req, res) => {
    const { user } = (res.locals as { auth: AuthContext }).auth;
    res.json(await notifications.preferences(user.id));
  });

  router.patch("/preferences", authenticated, async (req, res) => {
    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body) ||
        Object.keys(req.body).length !== 1 || typeof req.body.pushEnabled !== "boolean") {
      throw new HttpError(400, "invalid_request");
    }
    const { user } = (res.locals as { auth: AuthContext }).auth;
    res.json(await notifications.setPreferences(user.id, req.body.pushEnabled));
  });

  router.put("/tokens/current", authenticated, async (req, res) => {
    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body) ||
        Object.keys(req.body).length !== 1 || typeof req.body.token !== "string") {
      throw new HttpError(400, "invalid_request");
    }
    const context = (res.locals as { auth: AuthContext }).auth;
    await notifications.register(context, req.body.token);
    res.status(204).end();
  });

  router.delete("/tokens/current", authenticated, async (_req, res) => {
    const context = (res.locals as { auth: AuthContext }).auth;
    await notifications.remove(context.user.id, context.deviceId);
    res.status(204).end();
  });

  return router;
}
