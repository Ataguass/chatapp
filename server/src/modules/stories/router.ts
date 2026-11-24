import { Router, type Request, type Response } from "express";
import { downloadPrivateFile } from "../../infrastructure/private-download.ts";
import { requireAuth, type AuthService } from "../auth/router.ts";
import { HttpError, type AuthContext } from "../auth/service.ts";
import type { StoryService } from "./service.ts";

function user(res: Response) {
  return (res.locals as { auth: AuthContext }).auth.user.id;
}

function cursor(req: Request) {
  const value = req.query.cursor;
  if (value !== undefined && typeof value !== "string") throw new HttpError(400, "invalid_cursor");
  return value;
}

export function createStoriesRouter(auth: AuthService, stories: StoryService) {
  const router = Router();
  router.use(requireAuth(auth));

  router.post("/", async (req, res) => {
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 2 ||
        typeof body.clientId !== "string" || typeof body.text !== "string") throw new HttpError(400, "invalid_request");
    const result = await stories.publish(user(res), body.clientId, body.text);
    res.status(result.created ? 201 : 200).json(result.story);
  });

  router.post("/media", async (req, res) => {
    const clientId = req.get("X-Client-Message-Id");
    const fileName = req.get("X-File-Name");
    const contentType = req.get("Content-Type");
    if (!clientId || !fileName || !contentType) throw new HttpError(400, "invalid_request");
    const result = await stories.publish(user(res), clientId, req.get("X-Message-Text") ?? "", {
      fileName, contentType, contentLength: req.get("Content-Length"),
      contentEncoding: req.get("Content-Encoding"), body: req,
    });
    res.status(result.created ? 201 : 200).json(result.story);
  });

  router.get("/feed", async (req, res) => res.json(await stories.feed(user(res), cursor(req))));
  router.get("/privacy", async (_req, res) => res.json(await stories.privacy(user(res))));
  router.patch("/privacy", async (req, res) => {
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 2 ||
        !["everyone", "connections", "selected", "excluded"].includes(body.visibility) ||
        !Array.isArray(body.userIds) || body.userIds.some((id: unknown) => typeof id !== "string")) {
      throw new HttpError(400, "invalid_request");
    }
    res.json(await stories.setPrivacy(user(res), body));
  });

  router.get("/:storyId", async (req, res) => res.json(await stories.get(req.params.storyId, user(res))));
  router.get("/:storyId/media", async (req, res) => downloadPrivateFile(req, res,
    await stories.open(req.params.storyId, user(res))));
  router.post("/:storyId/views", async (req, res) => {
    await stories.markViewed(req.params.storyId, user(res));
    res.status(204).end();
  });
  router.get("/:storyId/viewers", async (req, res) => res.json(await stories.viewers(req.params.storyId, user(res), cursor(req))));
  router.delete("/:storyId", async (req, res) => {
    await stories.remove(req.params.storyId, user(res));
    res.status(204).end();
  });
  return router;
}
