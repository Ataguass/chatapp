/** Public HTTP response contract. Internal dependency details are only logged server-side. */
export type HealthResponse = { status: "live" | "ready" | "unavailable" };
