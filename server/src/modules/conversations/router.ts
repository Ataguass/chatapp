import { Router } from "express";
import type { Response } from "express";
import type { GroupConversationUpdatedEvent, GroupMemberEvent, GroupMemberRemovedEvent } from "@messaging/contracts";
import { HttpError } from "../auth/service.ts";
import { requireAuth } from "../auth/router.ts";
import type { AuthService } from "../auth/router.ts";
import type { AuthContext } from "../auth/service.ts";
import type { ConversationService, DirectTarget } from "./service.ts";

type GroupPublishers = {
  memberAdded?: (event: GroupMemberEvent) => void;
  memberRemoved?: (event: GroupMemberRemovedEvent) => void;
  roleChanged?: (event: GroupMemberEvent) => void;
  updated?: (event: GroupConversationUpdatedEvent) => void;
};

function context(res: Response) {
  return (res.locals as { auth: AuthContext }).auth;
}

function bodyObject(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "invalid_request");
  return value as Record<string, unknown>;
}

function exactFields(body: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(body).some(key => !allowed.includes(key))) throw new HttpError(400, "invalid_request");
}

function requestTarget(value: unknown): DirectTarget {
  const body = bodyObject(value);
  exactFields(body, ["username", "userId"]);
  if (typeof body.username === "string" && body.userId === undefined) {
    return { username: body.username };
  }
  if (typeof body.userId === "string" && body.username === undefined &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.userId)) {
    return { userId: body.userId };
  }
  throw new HttpError(400, "invalid_request");
}

function requestUserIds(value: unknown, allowEmpty = false) {
  if (!Array.isArray(value) || (!allowEmpty && value.length < 1) || value.some(id => typeof id !== "string")) {
    throw new HttpError(400, "invalid_group_members");
  }
  return value as string[];
}

export function createConversationsRouter(
  auth: AuthService,
  conversations: ConversationService,
  publishGroup?: GroupPublishers,
) {
  const router = Router();
  const authenticated = requireAuth(auth);

  router.get("/", authenticated, async (_req, res) => {
    res.json(await conversations.list(context(res).user.id));
  });

  router.post("/direct", authenticated, async (req, res) => {
    const result = await conversations.openDirect(context(res).user.id, requestTarget(req.body));
    res.status(result.created ? 201 : 200).json(result.conversation);
  });

  router.post("/groups", authenticated, async (req, res) => {
    const body = bodyObject(req.body);
    exactFields(body, ["title", "userIds"]);
    if (typeof body.title !== "string") throw new HttpError(400, "invalid_group_title");
    const group = await conversations.createGroup(context(res).user.id, body.title, requestUserIds(body.userIds));
    res.status(201).json(group);
  });

  router.post("/invites/redeem", authenticated, async (req, res) => {
    const body = bodyObject(req.body);
    exactFields(body, ["token"]);
    if (typeof body.token !== "string") throw new HttpError(400, "invalid_request");
    const result = await conversations.redeemInvite(context(res).user.id, body.token);
    if (result.joined) publishGroup?.memberAdded?.({
      conversationId: result.conversationId, userId: context(res).user.id, role: "member",
    });
    res.json({ joined: result.joined, conversation: await conversations.get(result.conversationId, context(res).user.id) });
  });

  router.get("/:conversationId", authenticated, async (req, res) => {
    res.json(await conversations.get(req.params.conversationId, context(res).user.id));
  });

  router.patch("/:conversationId", authenticated, async (req, res) => {
    const body = bodyObject(req.body);
    exactFields(body, ["title"]);
    if (typeof body.title !== "string") throw new HttpError(400, "invalid_group_title");
    const conversation = await conversations.updateGroupTitle(req.params.conversationId, context(res).user.id, body.title);
    publishGroup?.updated?.({ conversation });
    res.json(conversation);
  });

  router.get("/:conversationId/members", authenticated, async (req, res) => {
    res.json(await conversations.members(req.params.conversationId, context(res).user.id));
  });

  router.post("/:conversationId/members", authenticated, async (req, res) => {
    const body = bodyObject(req.body);
    exactFields(body, ["userIds"]);
    const result = await conversations.addMembers(req.params.conversationId, context(res).user.id,
      requestUserIds(body.userIds));
    for (const userId of result.addedUserIds) {
      publishGroup?.memberAdded?.({ conversationId: req.params.conversationId, userId, role: "member" });
    }
    res.json(result);
  });

  router.delete("/:conversationId/members/:userId", authenticated, async (req, res) => {
    const result = await conversations.removeMember(req.params.conversationId, context(res).user.id, req.params.userId);
    publishGroup?.memberRemoved?.({ conversationId: result.conversationId, userId: result.userId });
    res.json({ removed: true });
  });

  router.patch("/:conversationId/members/:userId/role", authenticated, async (req, res) => {
    const body = bodyObject(req.body);
    exactFields(body, ["role"]);
    if (body.role !== "admin" && body.role !== "member") throw new HttpError(400, "invalid_group_role");
    const result = await conversations.setMemberRole(req.params.conversationId, context(res).user.id,
      req.params.userId, body.role);
    publishGroup?.roleChanged?.(result);
    res.json(result);
  });

  router.post("/:conversationId/transfer-ownership", authenticated, async (req, res) => {
    const body = bodyObject(req.body);
    exactFields(body, ["userId"]);
    if (typeof body.userId !== "string") throw new HttpError(400, "invalid_request");
    const result = await conversations.transferOwnership(req.params.conversationId, context(res).user.id, body.userId);
    publishGroup?.roleChanged?.({ conversationId: req.params.conversationId,
      userId: result.previousOwnerId, role: "admin" });
    publishGroup?.roleChanged?.({ conversationId: req.params.conversationId,
      userId: result.userId, role: "owner" });
    res.json({ conversationId: result.conversationId, ownerId: result.userId });
  });

  router.post("/:conversationId/leave", authenticated, async (req, res) => {
    const result = await conversations.leaveGroup(req.params.conversationId, context(res).user.id);
    publishGroup?.memberRemoved?.({ conversationId: result.conversationId, userId: result.userId });
    res.json({ left: true });
  });

  router.post("/:conversationId/invites", authenticated, async (req, res) => {
    const body = req.body === undefined ? {} : bodyObject(req.body);
    exactFields(body, ["expiresInHours", "maxUses"]);
    const expiresInHours = body.expiresInHours ?? 168;
    const maxUses = body.maxUses ?? 100;
    if (typeof expiresInHours !== "number" || typeof maxUses !== "number") {
      throw new HttpError(400, "invalid_request");
    }
    res.status(201).json(await conversations.createInvite(req.params.conversationId,
      context(res).user.id, expiresInHours, maxUses));
  });

  router.get("/:conversationId/invites", authenticated, async (req, res) => {
    res.json(await conversations.listInvites(req.params.conversationId, context(res).user.id));
  });

  router.delete("/:conversationId/invites/:inviteId", authenticated, async (req, res) => {
    res.json(await conversations.revokeInvite(req.params.conversationId, context(res).user.id, req.params.inviteId));
  });

  return router;
}
