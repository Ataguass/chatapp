import type { Prisma, PrismaClient, ReportCategory, ReportStatus } from "@prisma/client";
import { mediaDefaults, type MediaLimits } from "../../infrastructure/private-upload.ts";
import { HttpError } from "../auth/service.ts";
import type { MessageService } from "../messages/service.ts";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function systemAdminIds(value: string | undefined) {
  const supplied = (value ?? "").split(",").map(id => id.trim().toLowerCase()).filter(Boolean);
  if (supplied.some(id => !uuid.test(id))) throw new Error("Invalid SYSTEM_ADMIN_USER_IDS");
  return new Set(supplied);
}

export function createAdminService(db: PrismaClient, messages: MessageService, limits: MediaLimits) {
  const defaults = mediaDefaults(limits);
  return {
    async report(userId: string, conversationId: string, messageId: string, category: ReportCategory, details: string) {
      if (!uuid.test(messageId) || [...details].length > 1000) throw new HttpError(400, "invalid_report");
      await messages.authorize(conversationId, userId);
      const message = await db.message.findFirst({ where: { id: messageId, conversationId, deletedAt: null,
        deletions: { none: { userId } } }, select: { senderId: true } });
      if (!message) throw new HttpError(404, "message_not_found");
      if (message.senderId === userId) throw new HttpError(400, "cannot_report_self");
      const report = await db.moderationReport.upsert({
        where: { messageId_reporterId: { messageId, reporterId: userId } },
        create: { messageId, reporterId: userId, category, details: details.trim() },
        update: {},
        select: { id: true, status: true, createdAt: true },
      });
      return report;
    },

    async reports(status: ReportStatus, cursor?: string) {
      const where: Prisma.ModerationReportWhereInput = { status };
      if (cursor !== undefined) {
        const match = /^(\d{13})_([\da-f-]{36})$/i.exec(cursor);
        if (!match || !uuid.test(match[2])) throw new HttpError(400, "invalid_cursor");
        const createdAt = new Date(Number(match[1]));
        where.OR = [{ createdAt: { lt: createdAt } }, { createdAt, id: { lt: match[2] } }];
      }
      const rows = await db.moderationReport.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        include: { message: { select: { conversationId: true, senderId: true, deletedAt: true } } }, take: 51 });
      const page = rows.slice(0, 50);
      const last = page.at(-1);
      return { reports: page, nextCursor: rows.length > 50 && last ? `${last.createdAt.getTime()}_${last.id}` : null };
    },

    async review(id: string, reviewerId: string, status: "resolved" | "dismissed") {
      if (!uuid.test(id)) throw new HttpError(400, "invalid_report_id");
      await db.moderationReport.updateMany({ where: { id, status: "pending" },
        data: { status, reviewedById: reviewerId, reviewedAt: new Date() } });
      const report = await db.moderationReport.findUnique({ where: { id } });
      if (!report) throw new HttpError(404, "report_not_found");
      if (report.status !== status) throw new HttpError(409, "report_already_reviewed");
      return report;
    },

    async setMediaPolicy(category: string, userId: string, input: { enabled: boolean; maxBytes: number; contentTypes: string[] }) {
      const base = defaults.find(rule => rule.category === category);
      const contentTypes = [...new Set(input.contentTypes)];
      if (!base || !Number.isInteger(input.maxBytes) || input.maxBytes < 1024 || input.maxBytes > base.maxBytes ||
          contentTypes.some(type => !base.contentTypes.includes(type)) || (input.enabled && !contentTypes.length)) {
        throw new HttpError(400, "invalid_media_policy");
      }
      const data = { enabled: input.enabled, maxBytes: input.maxBytes, contentTypes, updatedById: userId };
      return db.mediaPolicy.upsert({ where: { category: base.category },
        create: { category: base.category, ...data }, update: data });
    },
  };
}

export type AdminService = ReturnType<typeof createAdminService>;
