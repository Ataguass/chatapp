import { Router, type Response } from "express";
import { requireAuth, type AuthService } from "../auth/router.ts";
import { HttpError, type AuthContext } from "../auth/service.ts";
import type { CallHistory } from "./history.ts";
import { callIceConfiguration, type readIceSettings } from "./ice.ts";

function user(res: Response) {
  return (res.locals as { auth: AuthContext }).auth.user.id;
}

export function createCallsRouter(auth: AuthService, history: CallHistory, ice: ReturnType<typeof readIceSettings>) {
  const router = Router();
  router.use(requireAuth(auth));
  router.get("/ice", (_req, res) => { res.json(callIceConfiguration(ice, user(res))); });
  router.get("/history", async (req, res) => {
    const { cursor } = req.query;
    if (cursor !== undefined && typeof cursor !== "string") throw new HttpError(400, "invalid_cursor");
    res.json(await history.list(user(res), cursor));
  });
  router.get("/:callId", async (req, res) => res.json(await history.get(req.params.callId, user(res))));
  return router;
}
