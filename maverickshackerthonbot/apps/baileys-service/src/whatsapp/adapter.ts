import { NormalizedIncomingMessage } from "../types.js";

export interface WhatsAppAdapter {
  sendMessage(to: string, text: string): Promise<void>;
  onIncoming(handler: (msg: NormalizedIncomingMessage) => Promise<void>): Promise<void>;
}