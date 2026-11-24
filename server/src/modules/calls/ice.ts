import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import type { CallIceConfiguration } from "@messaging/contracts";

export function readIceSettings(env: Readonly<Record<string, string | undefined>>) {
  const urls = [...new Set((env.CALL_ICE_URLS ?? "").split(",").map(url => url.trim()).filter(Boolean))];
  const valid = /^(?:stuns?|turns?):(?:[a-z\d.-]+|\[[a-f\d:]+\])(?::\d{1,5})?(?:\?transport=(?:udp|tcp))?$/i;
  if (urls.length > 8 || urls.some(url => !valid.test(url))) throw new Error("Invalid CALL_ICE_URLS");
  const turnUrls = urls.filter(url => /^turns?:/i.test(url));
  const stunUrls = urls.filter(url => /^stuns?:/i.test(url));
  const secretFile = env.CALL_TURN_SECRET_FILE;
  if (Boolean(turnUrls.length) !== Boolean(secretFile)) throw new Error("Invalid CALL_TURN_SECRET_FILE or TURN URLs");
  let secret: string | undefined;
  if (secretFile) {
    try { secret = readFileSync(secretFile, "utf8").trim(); }
    catch { throw new Error("Unable to read CALL_TURN_SECRET_FILE"); }
    if (!/^[!-~]{32,512}$/.test(secret)) throw new Error("Invalid CALL_TURN_SECRET_FILE");
  }
  return { turnUrls, stunUrls, secret };
}

export function callIceConfiguration(settings: ReturnType<typeof readIceSettings>, userId: string,
  now = Date.now()): CallIceConfiguration {
  const iceServers: CallIceConfiguration["iceServers"] = [];
  if (settings.stunUrls.length) iceServers.push({ urls: settings.stunUrls });
  if (!settings.secret) return { iceServers, expiresAt: null };
  const expirySeconds = Math.floor(now / 1000) + 600;
  const username = `${expirySeconds}:${userId}`;
  const credential = createHmac("sha1", settings.secret).update(username).digest("base64");
  iceServers.push({ urls: settings.turnUrls, username, credential });
  return { iceServers, expiresAt: new Date(expirySeconds * 1000).toISOString() };
}
