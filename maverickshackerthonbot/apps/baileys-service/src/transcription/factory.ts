import { config } from "../config.js";
import { Transcriber } from "./transcriber.js";
import { OpenAIWhisperTranscriber } from "./openai-whisper.js";

export function createTranscriber(): Transcriber {
  if (config.OPENAI_API_KEY) {
    return new OpenAIWhisperTranscriber();
  }

  return {
    async transcribeAudio() {
      return "Transcribed voice note text";
    }
  };
}