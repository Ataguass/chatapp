type Fields = {
  requestId?: string;
  route?: "live" | "ready" | "auth" | "users" | "push" | "conversations" | "messages" | "stories" | "media" | "calls" |
    "admin" | "reports" | "unmatched";
  status?: number;
  durationMs?: number;
  port?: number;
  dependency?: "postgresql" | "redis";
  count?: number;
  signal?: string;
  reason?: string;
};

export type Logger = (event: string, fields?: Fields) => void;
export const log: Logger = (event, fields = {}) => {
  process.stdout.write(JSON.stringify({ time: new Date().toISOString(), event, ...fields }) + "\n");
};
