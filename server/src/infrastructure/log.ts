type Fields = {
  requestId?: string;
  route?: "live" | "ready" | "unmatched";
  status?: number;
  durationMs?: number;
  port?: number;
  dependency?: "postgresql" | "redis";
  signal?: string;
  reason?: string;
};

export type Logger = (event: string, fields?: Fields) => void;
export const log: Logger = (event, fields = {}) => {
  process.stdout.write(JSON.stringify({ time: new Date().toISOString(), event, ...fields }) + "\n");
};
