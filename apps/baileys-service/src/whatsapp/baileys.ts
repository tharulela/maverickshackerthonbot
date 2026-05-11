import makeWASocket, {
  ConnectionState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  proto,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";
import qrcode from "qrcode-terminal";
import { logger } from "../logger.js";
import { createTranscriber } from "../transcription/factory.js";
import { normalizeMessage } from "./normalize.js";
import { downloadVoiceNote } from "./media.js";
import { NormalizedIncomingMessage } from "../types.js";
import { WhatsAppAdapter } from "./adapter.js";

export async function createBaileysAdapter(): Promise<WhatsAppAdapter> {
  const { state, saveCreds } = await useMultiFileAuthState("./auth");
  const { version } = await fetchLatestBaileysVersion();

  const socket = makeWASocket({
    auth: state,
    version,
  });

  const transcriber = createTranscriber();
  let incomingHandler:
    | ((msg: NormalizedIncomingMessage) => Promise<void>)
    | null = null;

  socket.ev.on("creds.update", saveCreds);

  socket.ev.on("connection.update", (update: Partial<ConnectionState>) => {
    if (update.qr) {
      logger.info("Scan this QR code with WhatsApp Linked Devices");
      qrcode.generate(update.qr, { small: true });
    }

    if (update.connection === "open") {
      logger.info("WhatsApp connection established");
      return;
    }

    if (update.connection === "close") {
      const disconnectError = update.lastDisconnect?.error as
        | { output?: { statusCode?: number } }
        | undefined;
      const statusCode = disconnectError?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      logger.warn(
        { statusCode, shouldReconnect },
        "WhatsApp connection closed",
      );

      if (shouldReconnect) {
        void createBaileysAdapter();
      }
    }
  });

  socket.ev.on(
    "messages.upsert",
    async (event: { messages: proto.IWebMessageInfo[]; type: string }) => {
      if (event.type !== "notify" || !incomingHandler) {
        return;
      }

      for (const message of event.messages) {
        if (message.key.fromMe) {
          continue;
        }

        let voiceText: string | undefined;
        let mediaPath: string | undefined;

        if (message.message?.audioMessage) {
          try {
            mediaPath = await downloadVoiceNote(message as any);
            voiceText = await transcriber.transcribeAudio(mediaPath);
          } catch (error) {
            logger.warn({ error }, "Voice note processing failed");
          }
        }

        const normalized = await normalizeMessage(
          message,
          voiceText,
          mediaPath,
        );
        await incomingHandler(normalized);
      }
    },
  );

  return {
    async sendMessage(to: string, text: string) {
      await socket.sendMessage(to, { text });
    },
    async onIncoming(
      handler: (msg: NormalizedIncomingMessage) => Promise<void>,
    ) {
      incomingHandler = handler;
    },
  };
}
