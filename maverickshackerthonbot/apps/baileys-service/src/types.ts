export type MessageType = "text" | "voice" | "unknown";

export interface NormalizedIncomingMessage {
  messageId: string;
  from: string;
  timestamp: number;
  type: MessageType;
  text?: string;
  mimeType?: string;
  mediaPath?: string;
  languageHint?: string;
}