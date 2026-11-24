import { Router, type Response } from "express";
import type { ReportCategory, ReportStatus } from "@prisma/client";
import type { PrivateMedia } from "../../infrastructure/private-upload.ts";
import { requireAuth, type AuthService } from "../auth/router.ts";
import { HttpError, type AuthContext } from "../auth/service.ts";
import type { AdminService } from "./service.ts";

function user(res: Response) {
  return (res.locals as { auth: AuthContext }).auth.user.id;
}

export function createReportsRouter(auth: AuthService, service: AdminService) {
  const router = Router();
  router.post("/", requireAuth(auth), async (req, res) => {
    const { conversationId, messageId, category, details = "" } = req.body ?? {};
    if (typeof conversationId !== "string" || typeof messageId !== "string" ||
        !["spam", "harassment", "inappropriate", "other"].includes(category) || typeof details !== "string") {
      throw new HttpError(400, "invalid_report");
    }
    res.status(202).json(await service.report(user(res), conversationId, messageId, category as ReportCategory, details));
  });
  return router;
}

export function createAdminRouter(auth: AuthService, admin: { service: AdminService; ids: ReadonlySet<string> },
  media: PrivateMedia, ready: () => Promise<boolean>) {
  const router = Router();
  router.use(requireAuth(auth), (_req, res, next) => {
    if (!admin.ids.has(user(res))) return next(new HttpError(403, "admin_required"));
    next();
  });
  router.get("/reports", async (req, res) => {
    const { cursor, status = "pending" } = req.query;
    if (cursor !== undefined && typeof cursor !== "string") throw new HttpError(400, "invalid_cursor");
    if (typeof status !== "string" || !["pending", "resolved", "dismissed"].includes(status)) {
      throw new HttpError(400, "invalid_report_status");
    }
    res.json(await admin.service.reports(status as ReportStatus, cursor));
  });
  router.patch("/reports/:reportId", async (req, res) => {
    const status = req.body?.status;
    if (status !== "resolved" && status !== "dismissed") throw new HttpError(400, "invalid_report_status");
    res.json(await admin.service.review(req.params.reportId, user(res), status));
  });
  router.get("/system/health", async (_req, res) => {
    const ok = await ready();
    res.status(ok ? 200 : 503).json({ status: ok ? "ready" : "unavailable" });
  });
  router.get("/media-policies", async (_req, res) => res.json(await media.policies()));
  router.patch("/media-policies/:category", async (req, res) => {
    const { enabled, maxBytes, contentTypes } = req.body ?? {};
    if (typeof enabled !== "boolean" || typeof maxBytes !== "number" || !Array.isArray(contentTypes) ||
        contentTypes.some((value: unknown) => typeof value !== "string")) throw new HttpError(400, "invalid_media_policy");
    res.json(await admin.service.setMediaPolicy(req.params.category, user(res), { enabled, maxBytes, contentTypes }));
  });
  return router;
}
