export interface Transcriber {
  transcribeAudio(filePath: string): Promise<string>;
}