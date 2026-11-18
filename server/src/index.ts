import { createServer } from "node:http";
import { createApp } from "./app.ts";
import { settings } from "./config/settings.ts";
import { log } from "./infrastructure/log.ts";
import { openServices } from "./infrastructure/services.ts";

function start() {
  const config = settings(process.env);
  const services = openServices(config, log);
  const server = createServer(createApp(services.ready, log));
  server.headersTimeout = 10000;
  server.requestTimeout = 30000;
  let stopping = false;
  function stop(reason: string, exitCode = 0) {
    if (stopping) return;
    stopping = true;
    services.drain();
    log("server.stopping", { reason });
    const hardDeadline = setTimeout(() => process.exit(1), 10000);
    server.close(async () => {
      try {
        await services.close();
        process.exitCode = exitCode;
      } catch {
        process.exitCode = 1;
      } finally {
        clearTimeout(hardDeadline);
      }
    });
  }
  server.on("error", () => stop("http_error", 1));
  process.once("SIGTERM", () => stop("SIGTERM"));
  process.once("SIGINT", () => stop("SIGINT"));
  server.listen(config.port, config.host, () => log("server.started", { port: config.port }));
}

try {
  start();
} catch {
  log("server.start_failed");
  process.exitCode = 1;
}
