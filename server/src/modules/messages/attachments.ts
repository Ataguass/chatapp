import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Prisma, PrismaClient } from "@prisma/client";
import type { MessageService } from "./service.ts";
import { HttpError } from "../auth/service.ts";

export type MediaCategory = "image" | "video" | "audio" | "document";
export type MediaLimits = Record<MediaCategory, number>;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
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

export function createAttachmentService(
  db: PrismaClient,
  messages: MessageService,
  storagePath: string,
  limits: MediaLimits,
) {
  return {
    async send(input: {
      conversationId: string;
      userId: string;
      clientMessageId: string;
      replyToMessageId?: string | null;
      content?: string;
      fileName: string;
      contentType: string;
      contentLength?: string;
      contentEncoding?: string;
      body: Readable;
    }) {
      if (!uuidPattern.test(input.clientMessageId)) throw new HttpError(400, "invalid_client_message_id");
      if (input.replyToMessageId && !uuidPattern.test(input.replyToMessageId)) {
        throw new HttpError(400, "invalid_reply_target");
      }
      if (input.content !== undefined && [...input.content].length > 4000) {
        throw new HttpError(400, "invalid_message_content");
      }
      if (input.contentEncoding && input.contentEncoding.toLowerCase() !== "identity") {
        throw new HttpError(415, "unsupported_content_encoding");
      }
      await messages.authorize(input.conversationId, input.userId);
      const fileName = cleanFileName(input.fileName);
      const contentType = input.contentType.split(";", 1)[0].trim().toLowerCase();
      const category = mediaTypes[contentType];
      if (!category) throw new HttpError(415, "unsupported_media_type");
      const maxBytes = limits[category];
      if (input.contentLength !== undefined) {
        if (!/^\d+$/.test(input.contentLength)) throw new HttpError(400, "invalid_content_length");
        if (Number(input.contentLength) > maxBytes) throw new HttpError(413, "attachment_too_large");
      }

      await mkdir(storagePath, { recursive: true, mode: 0o700 });
      const storageKey = randomUUID();
      const partialPath = join(storagePath, `.${storageKey}.part`);
      const finalPath = join(storagePath, storageKey);
      let sizeBytes = 0;
      let prefix = Buffer.alloc(0);
      const digest = createHash("sha256");
      const meter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          sizeBytes += chunk.length;
          if (sizeBytes > maxBytes) {
            callback(new HttpError(413, "attachment_too_large"));
            return;
          }
          if (prefix.length < 32) prefix = Buffer.concat([prefix, chunk.subarray(0, 32 - prefix.length)]);
          digest.update(chunk);
          callback(null, chunk);
        },
      });
      try {
        await pipeline(input.body, meter, createWriteStream(partialPath, { flags: "wx", mode: 0o600 }));
      } catch (error) {
        await removeFile(partialPath);
        throw error;
      }
      if (!sizeBytes) {
        await removeFile(partialPath);
        throw new HttpError(400, "empty_attachment");
      }
      if (!validSignature(prefix, contentType)) {
        await removeFile(partialPath);
        throw new HttpError(415, "media_signature_mismatch");
      }

      const sha256 = digest.digest("hex");
      await rename(partialPath, finalPath);
      let attachmentId: string | undefined;
      try {
        const attachment = await db.attachment.create({
          data: {
            conversationId: input.conversationId,
            uploadedBy: input.userId,
            storageKey,
            fileName,
            contentType,
            category,
            sizeBytes: BigInt(sizeBytes),
            sha256,
          },
          select: { id: true },
        });
        attachmentId = attachment.id;
        const sent = await messages.send(input.conversationId, input.userId, {
          clientMessageId: input.clientMessageId,
          content: input.content ?? "",
          replyToMessageId: input.replyToMessageId,
          attachmentId,
        });
        if (!sent.created) {
          await db.attachment.delete({ where: { id: attachmentId } });
          attachmentId = undefined;
          await removeFile(finalPath);
        }
        return sent;
      } catch (error) {
        if (attachmentId) {
          try { await db.attachment.delete({ where: { id: attachmentId } }); } catch { /* best-effort cleanup */ }
        }
        await removeFile(finalPath);
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2003") {
          throw new HttpError(409, "attachment_unavailable");
        }
        throw error;
      }
    },

    async open(conversationId: string, userId: string, attachmentId: string) {
      await messages.authorize(conversationId, userId);
      if (!uuidPattern.test(attachmentId)) throw new HttpError(400, "invalid_attachment_id");
      const attachment = await db.attachment.findFirst({
        where: { id: attachmentId, conversationId },
        include: { message: { select: { deletedAt: true } } },
      });
      if (!attachment || !attachment.message || attachment.message.deletedAt) {
        throw new HttpError(404, "attachment_not_found");
      }
      const path = join(storagePath, attachment.storageKey);
      try {
        const details = await stat(path);
        if (!details.isFile() || details.size !== Number(attachment.sizeBytes)) throw new Error();
      } catch {
        throw new HttpError(404, "attachment_not_found");
      }
      return {
        stream: createReadStream(path),
        fileName: attachment.fileName,
        contentType: attachment.contentType,
        sizeBytes: Number(attachment.sizeBytes),
      };
    },
  };
}

export type AttachmentService = ReturnType<typeof createAttachmentService>;
