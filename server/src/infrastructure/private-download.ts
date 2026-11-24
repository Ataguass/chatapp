import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import type { Request, Response } from "express";

export type PrivateFile = { path: string; fileName: string; contentType: string; sizeBytes: number };

function rangeFor(header: string, size: number) {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header);
  if (!match || (!match[1] && !match[2]) || !size) return null;
  const first = match[1] ? Number(match[1]) : null;
  const last = match[2] ? Number(match[2]) : null;
  if ((first !== null && !Number.isSafeInteger(first)) || (last !== null && !Number.isSafeInteger(last))) return null;
  if (first === null) return last ? { start: Math.max(size - last, 0), end: size - 1 } : null;
  if (first >= size || (last !== null && last < first)) return null;
  return { start: first, end: Math.min(last ?? size - 1, size - 1) };
}

export async function downloadPrivateFile(req: Request, res: Response, file: PrivateFile) {
  const requested = req.headers.range;
  const range = requested ? rangeFor(requested, file.sizeBytes) : null;
  res.set({ "Accept-Ranges": "bytes", "Cache-Control": "private, no-store" });
  if (requested && !range) {
    res.status(416).set("Content-Range", `bytes */${file.sizeBytes}`).end();
    return;
  }
  const asciiName = file.fileName.replace(/[^\x20-\x7e]|["\\]/g, "_");
  const encodedName = encodeURIComponent(file.fileName).replace(/['()*]/g, char =>
    "%" + char.charCodeAt(0).toString(16).toUpperCase());
  res.status(range ? 206 : 200).set({
    "Content-Type": file.contentType,
    "Content-Length": String(range ? range.end - range.start + 1 : file.sizeBytes),
    "Content-Disposition": `attachment; filename="${asciiName}"; filename*=UTF-8''${encodedName}`,
    "X-Content-Type-Options": "nosniff",
  });
  if (range) res.set("Content-Range", `bytes ${range.start}-${range.end}/${file.sizeBytes}`);
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  await pipeline(createReadStream(file.path, range ?? undefined), res);
}
