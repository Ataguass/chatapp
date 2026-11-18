import express from "express";
import type { ErrorRequestHandler } from "express";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { HealthResponse } from "@messaging/contracts";
import type { Logger } from "./infrastructure/log.ts";

export function createApp(ready: () => Promise<boolean>, log: Logger) {
  const app = express();
  app.disable("x-powered-by");
  app.disable("etag");
  app.use((req, res, next) => {
    const requestId = randomUUID();
    const started = performance.now();
    const route = req.path === "/health/live" ? "live" : req.path === "/health/ready" ? "ready" : "unmatched";
    res.set({ "X-Request-Id": requestId, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    res.on("finish", () => log("http.request", {
      requestId, route, status: res.statusCode, durationMs: Math.round(performance.now() - started),
    }));
    next();
  });
  app.get("/health/live", (_req, res) => {
    res.json({ status: "live" } satisfies HealthResponse);
  });
  app.get("/health/ready", async (_req, res) => {
    const ok = await ready();
    res.status(ok ? 200 : 503).json({ status: ok ? "ready" : "unavailable" } satisfies HealthResponse);
  });
  app.use((_req, res) => { res.status(404).json({ error: "not_found" }); });
  const onError: ErrorRequestHandler = (_error, _req, res, next) => {
    if (res.headersSent) return next(_error);
    res.status(500).json({ error: "internal_error" });
  };
  app.use(onError);
  return app;
}
