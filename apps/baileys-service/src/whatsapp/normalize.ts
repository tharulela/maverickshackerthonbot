import { proto } from "@whiskeysockets/baileys";
import { NormalizedIncomingMessage } from "../types.js";

export async function normalizeMessage(
  message: proto.IWebMessageInfo,
  voiceText?: string,
  mediaPath?: string,
): Promise<NormalizedIncomingMessage> {
  const from = message.key.remoteJid!;
  const messageId = message.key.id!;
  const timestamp = Number(message.messageTimestamp) * 1000;
  const m = message.message;

  if (!m) {
    return { messageId, from, timestamp, type: "unknown" };
  }

  if (m.conversation) {
    return { messageId, from, timestamp, type: "text", text: m.conversation };
  }

  if (m.extendedTextMessage?.text) {
    return { messageId, from, timestamp, type: "text", text: m.extendedTextMessage.text };
  }

  if (m.audioMessage) {
    return {
      messageId,
      from,
      timestamp,
      type: "voice",
      text: voiceText,
      mimeType: m.audioMessage.mimetype || "audio/ogg",
      mediaPath
    };
  }

  if (m.imageMessage) {
    return {
      messageId,
      from,
      timestamp,
      type: "image",
      mimeType: m.imageMessage.mimetype || "image/jpeg",
      mediaPath,
      text: m.imageMessage.caption,
    };
  }

  if (m.documentMessage) {
    return {
      messageId,
      from,
      timestamp,
      type: "document",
      mimeType: m.documentMessage.mimetype || "application/octet-stream",
      mediaPath,
      text: m.documentMessage.caption,
    };
  }

  return { messageId, from, timestamp, type: "unknown" };
}
