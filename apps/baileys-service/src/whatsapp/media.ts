import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { downloadContentFromMessage, proto } from "@whiskeysockets/baileys";

async function streamToFile(stream: AsyncIterable<Buffer>, filePath: string) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  fs.writeFileSync(filePath, Buffer.concat(chunks));
}

export async function downloadVoiceNote(
  message: proto.IWebMessageInfo,
): Promise<string> {
  const dir = "./data/media";
  fs.mkdirSync(dir, { recursive: true });

  const filePath = path.join(dir, `${randomUUID()}.ogg`);
  const audioMessage = message.message?.audioMessage;
  if (!audioMessage) {
    throw new Error("No audio message found");
  }
  const stream = await downloadContentFromMessage(audioMessage, "audio");
  await streamToFile(stream, filePath);

  return filePath;
}

export async function downloadDocumentOrImage(
  mediaMessage: unknown,
  mediaType: "image" | "document",
): Promise<string> {
  const dir = "./data/media";
  fs.mkdirSync(dir, { recursive: true });

  const extension =
    mediaType === "image"
      ? ".jpg"
      : typeof mediaMessage === "object" &&
          mediaMessage !== null &&
          "fileName" in mediaMessage &&
          typeof (mediaMessage as { fileName?: string | null }).fileName === "string" &&
          (mediaMessage as { fileName?: string | null }).fileName!.includes(".")
        ? `.${String((mediaMessage as { fileName?: string | null }).fileName).split(".").pop()}`
        : ".bin";

  const filePath = path.join(dir, `${randomUUID()}${extension}`);
  const stream = await downloadContentFromMessage(
    mediaMessage as never,
    mediaType,
  );
  await streamToFile(stream, filePath);

  return filePath;
}
