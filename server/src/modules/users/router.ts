import { Router } from "express";
import type { Response } from "express";
import { HttpError } from "../auth/service.ts";
import { requireAuth } from "../auth/router.ts";
import type { AuthService } from "../auth/router.ts";
import type { AuthContext } from "../auth/service.ts";
import type { ProfilePatch, UserService } from "./service.ts";

function uuid(value: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new HttpError(400, "invalid_user_id");
  }
  return value;
}

function context(res: Response) {
  return (res.locals as { auth: AuthContext }).auth;
}

function body(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "invalid_request");
  return value as Record<string, unknown>;
}

function profilePatch(value: unknown): ProfilePatch {
  const source = body(value);
  const allowed = new Set(["displayName", "bio", "avatarUrl"]);
  if (Object.keys(source).some(key => !allowed.has(key))) throw new HttpError(400, "invalid_profile_field");
  const patch: ProfilePatch = {};
  if (Object.hasOwn(source, "displayName")) {
    if (typeof source.displayName !== "string") throw new HttpError(400, "invalid_display_name");
    patch.displayName = source.displayName;
  }
  if (Object.hasOwn(source, "bio")) {
    if (source.bio !== null && typeof source.bio !== "string") throw new HttpError(400, "invalid_bio");
    patch.bio = source.bio;
  }
  if (Object.hasOwn(source, "avatarUrl")) {
    if (source.avatarUrl !== null && typeof source.avatarUrl !== "string") {
      throw new HttpError(400, "invalid_avatar_url");
    }
    patch.avatarUrl = source.avatarUrl;
  }
  return patch;
}

export function createUsersRouter(auth: AuthService, users: UserService) {
  const router = Router();
  const authenticated = requireAuth(auth);

  router.get("/search", authenticated, async (req, res) => {
    if (typeof req.query.q !== "string") throw new HttpError(400, "invalid_search_query");
    res.json(await users.search(context(res).user.id, req.query.q));
  });

  router.get("/me", authenticated, (req, res) => {
    res.json(context(res).user);
  });

  router.patch("/me", authenticated, async (req, res) => {
    res.json(await users.updateProfile(context(res).user.id, profilePatch(req.body)));
  });

  router.post("/:id/block", authenticated, async (req, res) => {
    await users.block(context(res).user.id, uuid(req.params.id));
    res.status(204).end();
  });

  router.delete("/:id/block", authenticated, async (req, res) => {
    await users.unblock(context(res).user.id, uuid(req.params.id));
    res.status(204).end();
  });

  router.get("/:username", authenticated, async (req, res) => {
    res.json(await users.getByUsername(context(res).user.id, req.params.username));
  });

  return router;
}
