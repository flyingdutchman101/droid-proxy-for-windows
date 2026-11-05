// Google Gemini API voice (TTS) and video generation through the Interactions
// endpoint. These are not chat models, so they are called directly with the
// user's Gemini API key instead of going through CLIProxyAPI.
//
// Docs (Nov 2026): TTS models gemini-3.8-flash-tts / gemini-3.8-flash-lite-tts
// (free tier available); video gemini-omni-1.1-flash (paid only, ~$0.10/s at
// 720p). Veo was shut down in the Gemini API on Oct 22, 2026.

const fs = require("fs");
const path = require("path");

const INTERACTIONS_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";

const TTS_MODELS = [
  { id: "gemini-3.8-flash-tts", label: "Gemini 3.8 Flash TTS" },
  { id: "gemini-3.8-flash-lite-tts", label: "Gemini 3.8 Flash-Lite TTS (cheaper)" }
];
const VIDEO_MODELS = [{ id: "gemini-omni-1.1-flash", label: "Gemini Omni 1.1 Flash" }];

const VOICES = [
  ["Zephyr", "Bright"], ["Puck", "Upbeat"], ["Charon", "Informative"], ["Kore", "Firm"], ["Fenrir", "Excitable"],
  ["Leda", "Youthful"], ["Orus", "Firm"], ["Aoede", "Breezy"], ["Callirrhoe", "Easy-going"], ["Autonoe", "Bright"],
  ["Enceladus", "Breathy"], ["Iapetus", "Clear"], ["Umbriel", "Easy-going"], ["Algieba", "Smooth"], ["Despina", "Smooth"],
  ["Erinome", "Clear"], ["Algenib", "Gravelly"], ["Rasalgethi", "Informative"], ["Laomedeia", "Upbeat"], ["Achernar", "Soft"],
  ["Alnilam", "Firm"], ["Schedar", "Even"], ["Gacrux", "Mature"], ["Pulcherrima", "Forward"], ["Achird", "Friendly"],
  ["Zubenelgenubi", "Casual"], ["Vindemiatrix", "Gentle"], ["Sadachbia", "Lively"], ["Sadaltager", "Knowledgeable"], ["Sulafat", "Warm"]
].map(([name, style]) => ({ name, style }));

const ASPECT_RATIOS = ["16:9", "9:16"];
const RESOLUTIONS = ["360p", "720p", "1080p", "4k"];

// Finds the first output item of `type` ("audio" / "video") anywhere in an
// Interactions response; the documented path is steps[type=model_output].content[].
function findOutput(node, type) {
  if (!node || typeof node !== "object") return null;
  if (node.type === type && (node.data || node.uri)) return node;
  for (const value of Array.isArray(node) ? node : Object.values(node)) {
    const found = findOutput(value, type);
    if (found) return found;
  }
  return null;
}

// Raw 16-bit mono PCM (audio/l16) needs a RIFF header to be playable as .wav.
function pcmToWav(pcm, sampleRate = 24000) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function slug(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "output";
}

function stamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
}

function createMedia({ fetchImpl, getApiKey, outputDir, log }) {
  async function call(body, timeoutMs) {
    const apiKey = getApiKey();
    if (!apiKey) throw new Error("Add a Google Gemini API key first.");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(INTERACTIONS_URL, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      const text = await response.text();
      if (!response.ok) {
        let message = text.slice(0, 300);
        try {
          message = JSON.parse(text).error?.message || message;
        } catch {
          // keep raw text
        }
        throw new Error(`Gemini API ${response.status}: ${message}`);
      }
      return JSON.parse(text);
    } catch (error) {
      if (error.name === "AbortError") throw new Error("Gemini API timed out.");
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async function payload(item) {
    if (item.data) return Buffer.from(item.data, "base64");
    const response = await fetchImpl(item.uri, { headers: { "x-goog-api-key": getApiKey() } });
    if (!response.ok) throw new Error(`Could not download the result (${response.status})`);
    return Buffer.from(await response.arrayBuffer());
  }

  function save(name, buffer) {
    fs.mkdirSync(outputDir, { recursive: true });
    const file = path.join(outputDir, name);
    fs.writeFileSync(file, buffer);
    return file;
  }

  async function speak({ text, voice = "Kore", model = TTS_MODELS[0].id, style = "" }) {
    if (!String(text || "").trim()) throw new Error("Enter some text to speak.");
    const content = { type: "text", text: String(text) };
    if (style.trim()) content.annotations = [{ type: "speech_metadata", style: style.trim() }];
    const result = await call({
      model,
      input: [{ type: "user_input", content: [content] }],
      response_format: { type: "audio" },
      generation_config: { speech_config: [{ voice }] }
    }, 2 * 60 * 1000);
    const audio = findOutput(result, "audio");
    if (!audio) throw new Error("The response contained no audio.");
    let buffer = await payload(audio);
    // Unary responses are WAV already; headerless PCM gets a header.
    if (buffer.slice(0, 4).toString() !== "RIFF") buffer = pcmToWav(buffer);
    const file = save(`voice-${stamp()}-${voice}-${slug(text)}.wav`, buffer);
    log(`Voice: ${model} (${voice}) -> ${file}`);
    return { file, bytes: buffer.length };
  }

  async function video({ prompt, model = VIDEO_MODELS[0].id, aspectRatio = "16:9", resolution = "720p" }) {
    if (!String(prompt || "").trim()) throw new Error("Describe the video first.");
    const result = await call({
      model,
      input: String(prompt),
      response_format: { type: "video", aspect_ratio: aspectRatio, resolution }
    }, 10 * 60 * 1000);
    const clip = findOutput(result, "video");
    if (!clip) throw new Error("The response contained no video.");
    const buffer = await payload(clip);
    const file = save(`video-${stamp()}-${slug(prompt)}.mp4`, buffer);
    log(`Video: ${model} ${aspectRatio} ${resolution} -> ${file}`);
    return { file, bytes: buffer.length };
  }

  return { speak, video };
}

module.exports = { createMedia, findOutput, pcmToWav, TTS_MODELS, VIDEO_MODELS, VOICES, ASPECT_RATIOS, RESOLUTIONS };
