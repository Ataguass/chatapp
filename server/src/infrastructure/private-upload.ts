import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { HttpError } from "../modules/auth/service.ts";

export type MediaCategory = "image" | "video" | "audio" | "document";
export type MediaLimits = Record<MediaCategory, number>;
export type MediaRule = { category: MediaCategory; enabled: boolean; maxBytes: number; contentTypes: string[] };

const mediaTypes: Record<string, MediaCategory> = {
  "image/jpeg": "image",
  "image/png": "image",
  "image/webp": "image",
  "video/mp4": "video",
  "audio/mpeg": "audio",
  "audio/wav": "audio",
  "application/pdf": "document",
};

function cleanFileName(input: string) {
  let fileName: string;
  try {
    fileName = decodeURIComponent(input).trim();
  } catch {
    throw new HttpError(400, "invalid_file_name");
  }
  if (!fileName || [...fileName].length > 255 || fileName === "." || fileName === ".." ||
      /[\\/\u0000-\u001f\u007f]/u.test(fileName)) {
    throw new HttpError(400, "invalid_file_name");
  }
  return fileName;
}

function validSignature(prefix: Buffer, contentType: string) {
  if (contentType === "image/jpeg") return prefix.length >= 3 && prefix[0] === 0xff && prefix[1] === 0xd8 && prefix[2] === 0xff;
  if (contentType === "image/png") return prefix.length >= 8 && prefix.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (contentType === "image/webp") return prefix.length >= 12 && prefix.toString("ascii", 0, 4) === "RIFF" && prefix.toString("ascii", 8, 12) === "WEBP";
  if (contentType === "video/mp4") return prefix.length >= 12 && prefix.toString("ascii", 4, 8) === "ftyp";
  if (contentType === "audio/mpeg") {
    return prefix.length >= 3 && (prefix.toString("ascii", 0, 3) === "ID3" ||
      (prefix[0] === 0xff && (prefix[1] & 0xe0) === 0xe0));
  }
  if (contentType === "audio/wav") return prefix.length >= 12 && prefix.toString("ascii", 0, 4) === "RIFF" && prefix.toString("ascii", 8, 12) === "WAVE";
  if (contentType === "application/pdf") return prefix.length >= 5 && prefix.toString("ascii", 0, 5) === "%PDF-";
  return false;
}

async function removeFile(path: string) {
  try { await unlink(path); } catch { /* best-effort cleanup */ }
}

export type UploadBody = {
  fileName: string;
  contentType: string;
  contentLength?: string;
  contentEncoding?: string;
  body: Readable;
};

export function mediaDefaults(limits: MediaLimits): MediaRule[] {
  return (Object.keys(limits) as MediaCategory[]).map(category => ({
    category, enabled: true, maxBytes: limits[category],
    contentTypes: Object.keys(mediaTypes).filter(type => mediaTypes[type] === category),
  }));
}

export function createPrivateMedia(storagePath: string, limits: MediaLimits,
  overrides?: () => Promise<MediaRule[]>) {
  const defaults = mediaDefaults(limits);
  async function policies() {
    const rules = await overrides?.() ?? [];
    return defaults.map(base => {
      const rule = rules.find(item => item.category === base.category);
      if (!rule) return base;
      const contentTypes = base.contentTypes.filter(type => rule.contentTypes.includes(type));
      return { category: base.category, enabled: rule.enabled && contentTypes.length > 0,
        maxBytes: Math.min(base.maxBytes, rule.maxBytes), contentTypes };
    });
  }
  return {
    policies,

    async store(input: UploadBody, allowedCategories?: readonly MediaCategory[]) {
      if (input.contentEncoding && input.contentEncoding.toLowerCase() !== "identity") {
        throw new HttpError(415, "unsupported_content_encoding");
      }
      const fileName = cleanFileName(input.fileName);
      const contentType = input.contentType.split(";", 1)[0].trim().toLowerCase();
      if (!Object.hasOwn(mediaTypes, contentType)) throw new HttpError(415, "unsupported_media_type");
      const category = mediaTypes[contentType];
      if (allowedCategories && !allowedCategories.includes(category)) throw new HttpError(415, "unsupported_media_type");
      const policy = (await policies()).find(rule => rule.category === category);
      if (!policy?.enabled || !policy.contentTypes.includes(contentType)) throw new HttpError(415, "unsupported_media_type");
      const maxBytes = policy.maxBytes;
      if (input.contentLength !== undefined) {
        if (!/^\d+$/.test(input.contentLength)) throw new HttpError(400, "invalid_content_length");
        if (Number(input.contentLength) > maxBytes) throw new HttpError(413, "attachment_too_large");
      }

      await mkdir(storagePath, { recursive: true, mode: 0o700 });
      const storageKey = randomUUID();
      const partialPath = join(storagePath, `.${storageKey}.part`);
      let sizeBytes = 0;
      let prefix = Buffer.alloc(0);
      const digest = createHash("sha256");
      const meter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          sizeBytes += chunk.length;
          if (sizeBytes > maxBytes) return callback(new HttpError(413, "attachment_too_large"));
          if (prefix.length < 32) prefix = Buffer.concat([prefix, chunk.subarray(0, 32 - prefix.length)]);
          digest.update(chunk);
          callback(null, chunk);
        },
      });
      try {
        await pipeline(input.body.iterator({ destroyOnReturn: false }), meter,
          createWriteStream(partialPath, { flags: "wx", mode: 0o600 }));
        if (!sizeBytes) throw new HttpError(400, "empty_attachment");
        if (!validSignature(prefix, contentType)) throw new HttpError(415, "media_signature_mismatch");
        await rename(partialPath, join(storagePath, storageKey));
        return { storageKey, fileName, contentType, category, sizeBytes: BigInt(sizeBytes), sha256: digest.digest("hex") };
      } catch (error) {
        await removeFile(partialPath);
        throw error;
      }
    },

    async describe(file: { storageKey: string; fileName: string; contentType: string; sizeBytes: bigint }) {
      const path = join(storagePath, file.storageKey);
      const sizeBytes = Number(file.sizeBytes);
      const details = await stat(path).catch(() => null);
      if (!details?.isFile() || details.size !== sizeBytes) throw new HttpError(404, "attachment_not_found");
      return { path, fileName: file.fileName, contentType: file.contentType, sizeBytes };
    },

    async discard(storageKey: string) {
      await removeFile(join(storagePath, storageKey));
    },
  };
}

export type PrivateMedia = ReturnType<typeof createPrivateMedia>;
