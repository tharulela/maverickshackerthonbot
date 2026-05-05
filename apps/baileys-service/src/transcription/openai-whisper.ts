import fs from "node:fs";
import axios from "axios";
import { config } from "../config.js";
import { Transcriber } from "./transcriber.js";

export class OpenAIWhisperTranscriber implements Transcriber {
  async transcribeAudio(filePath: string): Promise<string> {
    if (!config.OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY is required for transcription");
    }

    const form = new FormData();
    form.append("file", fs.createReadStream(filePath) as any);
    form.append("model", "whisper-1");

    const response = await axios.post("https://api.openai.com/v1/audio/transcriptions", form, {
      headers: {
        Authorization: `Bearer ${config.OPENAI_API_KEY}`
      }
    });

    return response.data.text;
  }
}