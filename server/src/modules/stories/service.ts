import { Prisma, type PrismaClient } from "@prisma/client";
import type { PublicStory, StoryPrivacy } from "@messaging/contracts";
import type { PrivateMedia, UploadBody } from "../../infrastructure/private-upload.ts";
import { lockActiveAccount } from "../auth/account-lock.ts";
import { HttpError } from "../auth/service.ts";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const storyLifetimeMs = 24 * 60 * 60 * 1000;
const authorSelect = { id: true, username: true, displayName: true, avatarUrl: true } as const;

function visibleStories(viewerId: string): Prisma.StoryWhereInput {
  const recentParticipant = { leftAt: null, messages: { some: { deletedAt: null } } };
  const connection = { AND: [
    { members: { some: { ...recentParticipant, userId: viewerId } } },
    { members: { some: { ...recentParticipant, userId: { not: viewerId } } } },
  ] };
  const connected: Prisma.UserWhereInput = { OR: [
    { directFirst: { some: { userTwoId: viewerId, conversation: connection } } },
    { directSecond: { some: { userOneId: viewerId, conversation: connection } } },
  ] };
  return {
    expiresAt: { gt: new Date() },
    owner: {
      deletedAt: null,
      blocks: { none: { blockedId: viewerId } },
      blockedBy: { none: { blockerId: viewerId } },
      OR: [
        { id: viewerId },
        { storyPrivacy: { is: { visibility: "everyone" } } },
        { storyPrivacy: { is: { visibility: "selected", audience: { some: { userId: viewerId } } } } },
        { AND: [connected, { OR: [
          { storyPrivacy: { is: null } },
          { storyPrivacy: { is: { visibility: "connections" } } },
          { storyPrivacy: { is: { visibility: "excluded", audience: { none: { userId: viewerId } } } } },
        ] }] },
      ],
    },
  };
}

function storyInclude(viewerId: string) {
  return { owner: { select: authorSelect }, views: { where: { viewerId }, select: { viewerId: true } } } as const;
}

type StoryRow = Prisma.StoryGetPayload<{ include: ReturnType<typeof storyInclude> }>;

function view(row: StoryRow): PublicStory {
  return {
    id: row.id, author: row.owner, type: row.kind, text: row.text, viewed: row.views.length > 0,
    createdAt: row.createdAt.toISOString(), expiresAt: row.expiresAt.toISOString(),
    media: row.contentType && row.sizeBytes !== null ? {
      contentType: row.contentType, sizeBytes: Number(row.sizeBytes), downloadPath: `/v1/stories/${row.id}/media`,
    } : null,
  };
}

function requireStoryId(id: string) {
  if (!uuid.test(id)) throw new HttpError(400, "invalid_story_id");
}

export function createStoryService(db: PrismaClient, media: PrivateMedia) {
  return {
    async publish(userId: string, clientId: string, text: string, upload?: UploadBody) {
      if (!uuid.test(clientId)) throw new HttpError(400, "invalid_story_client_id");
      const caption = text.trim();
      if ([...caption].length > 1000 || (!upload && !caption)) throw new HttpError(400, "invalid_story_text");
      const key = { userId_clientId: { userId, clientId } };
      const prior = await db.story.findUnique({ where: key, include: storyInclude(userId) });
      if (prior) {
        if (prior.expiresAt <= new Date()) throw new HttpError(409, "story_expired");
        return { story: view(prior), created: false };
      }
      const file = upload ? await media.store(upload, ["image", "video"]) : undefined;
      try {
        const result = await db.$transaction(async tx => {
          if (!await lockActiveAccount(tx, userId)) throw new HttpError(401, "unauthorized");
          const same = await tx.story.findUnique({ where: key, include: storyInclude(userId) });
          if (same) {
            if (same.expiresAt <= new Date()) throw new HttpError(409, "story_expired");
            return { story: view(same), created: false };
          }
          const row = await tx.story.create({ data: {
            userId, clientId, text: caption, kind: file ? file.category === "image" ? "image" : "video" : "text",
            expiresAt: new Date(Date.now() + storyLifetimeMs),
            storageKey: file?.storageKey, fileName: file?.fileName, contentType: file?.contentType,
            sizeBytes: file?.sizeBytes, sha256: file?.sha256,
          }, include: storyInclude(userId) });
          return { story: view(row), created: true };
        });
        if (file && !result.created) await media.discard(file.storageKey);
        return result;
      } catch (error) {
        if (file) {
          const retained = await db.story.findUnique({ where: { storageKey: file.storageKey }, select: { id: true } })
            .catch(() => undefined);
          if (retained === null) await media.discard(file.storageKey);
        }
        throw error;
      }
    },

    async feed(viewerId: string, cursor?: string) {
      const where = visibleStories(viewerId);
      if (cursor !== undefined) {
        const match = /^(\d{13})_([\da-f-]{36})$/i.exec(cursor);
        if (!match || !uuid.test(match[2])) throw new HttpError(400, "invalid_cursor");
        const createdAt = new Date(Number(match[1]));
        where.OR = [{ createdAt: { lt: createdAt } }, { createdAt, id: { lt: match[2] } }];
      }
      const rows = await db.story.findMany({ where, include: storyInclude(viewerId),
        orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 51 });
      const page = rows.slice(0, 50);
      const last = page.at(-1);
      return { stories: page.map(view), nextCursor: rows.length > 50 && last ? `${last.createdAt.getTime()}_${last.id}` : null };
    },

    async get(id: string, viewerId: string) {
      requireStoryId(id);
      const row = await db.story.findFirst({ where: { ...visibleStories(viewerId), id }, include: storyInclude(viewerId) });
      if (!row) throw new HttpError(404, "story_not_found");
      return view(row);
    },

    async open(id: string, viewerId: string) {
      requireStoryId(id);
      const row = await db.story.findFirst({ where: { ...visibleStories(viewerId), id } });
      if (!row || !row.storageKey || !row.fileName || !row.contentType || row.sizeBytes === null) {
        throw new HttpError(404, "story_media_not_found");
      }
      return media.describe({ storageKey: row.storageKey, fileName: row.fileName,
        contentType: row.contentType, sizeBytes: row.sizeBytes });
    },

    async markViewed(id: string, viewerId: string) {
      requireStoryId(id);
      try {
        await db.$transaction(async tx => {
          if (!await lockActiveAccount(tx, viewerId)) throw new HttpError(401, "unauthorized");
          const row = await tx.story.findFirst({ where: { ...visibleStories(viewerId), id }, select: { userId: true } });
          if (!row) throw new HttpError(404, "story_not_found");
          if (viewerId === row.userId) return;
          await tx.storyView.createMany({ data: { storyId: id, viewerId }, skipDuplicates: true });
        });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2003") {
          throw new HttpError(404, "story_not_found");
        }
        throw error;
      }
    },

    async viewers(id: string, userId: string, cursor?: string) {
      requireStoryId(id);
      if (cursor !== undefined && !uuid.test(cursor)) throw new HttpError(400, "invalid_cursor");
      const row = await db.story.findFirst({ where: { id, userId, expiresAt: { gt: new Date() } }, select: {
        views: { where: { viewer: { deletedAt: null }, viewerId: cursor ? { gt: cursor } : undefined },
          orderBy: { viewerId: "asc" }, take: 101, select: { viewer: { select: authorSelect }, viewedAt: true } },
      } });
      if (!row) throw new HttpError(404, "story_not_found");
      const page = row.views.slice(0, 100);
      return { viewers: page.map(entry => ({ user: entry.viewer, viewedAt: entry.viewedAt.toISOString() })),
        nextCursor: row.views.length > 100 ? page[99].viewer.id : null };
    },

    async remove(id: string, userId: string) {
      requireStoryId(id);
      await db.$transaction(async tx => {
        const row = await tx.story.findFirst({ where: { id, userId }, select: { storageKey: true } });
        if (!row) throw new HttpError(404, "story_not_found");
        const removed = await tx.story.deleteMany({ where: { id, userId } });
        if (removed.count && row.storageKey) {
          await tx.pendingMediaDeletion.createMany({ data: { storageKey: row.storageKey }, skipDuplicates: true });
        }
      });
    },

    async privacy(userId: string): Promise<StoryPrivacy> {
      const row = await db.storyPrivacy.findUnique({ where: { userId }, include: { audience: {
        select: { userId: true }, orderBy: { userId: "asc" },
      } } });
      return { visibility: row?.visibility ?? "connections", userIds: row?.audience.map(member => member.userId) ?? [] };
    },

    async setPrivacy(userId: string, input: StoryPrivacy) {
      const userIds = [...new Set(input.userIds.map(id => id.toLowerCase()))].sort();
      if (userIds.length > 500 || userIds.some(id => !uuid.test(id) || id === userId) ||
          (userIds.length && (input.visibility === "connections" || input.visibility === "everyone"))) {
        throw new HttpError(400, "invalid_story_audience");
      }
      await db.$transaction(async tx => {
        if (!await lockActiveAccount(tx, userId)) throw new HttpError(401, "unauthorized");
        const found = await tx.user.count({ where: { id: { in: userIds }, deletedAt: null } });
        if (found !== userIds.length) throw new HttpError(400, "invalid_story_audience");
        await tx.storyPrivacy.upsert({ where: { userId },
          create: { userId, visibility: input.visibility }, update: { visibility: input.visibility } });
        await tx.storyAudience.deleteMany({ where: { ownerId: userId } });
        if (userIds.length) await tx.storyAudience.createMany({ data: userIds.map(id => ({ ownerId: userId, userId: id })) });
      });
      return { visibility: input.visibility, userIds };
    },
  };
}

export type StoryService = ReturnType<typeof createStoryService>;
