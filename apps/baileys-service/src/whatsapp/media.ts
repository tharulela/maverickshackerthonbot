import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { downloadContentFromMessage } from "@whiskeysockets/baileys";

async function streamToFile(stream: AsyncIterable<Buffer>, filePath: string) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  fs.writeFileSync(filePath, Buffer.concat(chunks));
}

export async function downloadVoiceNote(message: any): Promise<string> {
  const dir = "./data/media";
  fs.mkdirSync(dir, { recursive: true });

  const filePath = path.join(dir, `${randomUUID()}.ogg`);
  const stream = await downloadContentFromMessage(message.message.audioMessage, "audio");
  await streamToFile(stream, filePath);

  return filePath;
}

export async function downloadDocumentOrImage(
  mediaMessage: any,
  mediaType: "image" | "document",
): Promise<string> {
  const dir = "./data/media";
  fs.mkdirSync(dir, { recursive: true });

  const extension =
    mediaType === "image"
      ? ".jpg"
      : mediaMessage?.fileName?.includes(".")
        ? `.${String(mediaMessage.fileName).split(".").pop()}`
        : ".bin";

  const filePath = path.join(dir, `${randomUUID()}${extension}`);
  const stream = await downloadContentFromMessage(mediaMessage, mediaType);
  await streamToFile(stream, filePath);

  return filePath;
}
