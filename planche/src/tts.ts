// Read-aloud on top of the Web Speech API (system voices). The reader feeds
// a list of text segments (sentences); the speaker reads them in order and
// reports progress so the reader can highlight and turn pages.

import { t } from "./i18n";

export interface Segment {
  text: string;
  /** Opaque value for the caller (element, page number…). */
  ref?: unknown;
}

export interface SpeakOptions {
  voice: string;
  rate: number;
  pitch: number;
  lang?: string;
  onSegment?: (index: number, segment: Segment) => void;
  /** All segments read; return more to keep going (next page/chapter), or null to stop. */
  onEnd?: () => Promise<Segment[] | null> | Segment[] | null;
  onStateChange?: (state: TtsState) => void;
}

export type TtsState = "idle" | "playing" | "paused";

export const ttsSupported = () => typeof window !== "undefined" && "speechSynthesis" in window;

export function voices(): Promise<SpeechSynthesisVoice[]> {
  if (!ttsSupported()) return Promise.resolve([]);
  const list = speechSynthesis.getVoices();
  if (list.length) return Promise.resolve(list);
  return new Promise((resolve) => {
    const done = () => resolve(speechSynthesis.getVoices());
    speechSynthesis.addEventListener("voiceschanged", done, { once: true });
    setTimeout(done, 1500);
  });
}

/** Splits text into sentences for the given language. */
export function sentences(text: string, lang = "fr"): string[] {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const Seg = Intl.Segmenter as typeof Intl.Segmenter | undefined;
  if (!Seg) return clean.split(/(?<=[.!?…])\s+/);
  return [...new Seg(lang, { granularity: "sentence" }).segment(clean)].map((s) => s.segment.trim()).filter(Boolean);
}

export class Speaker {
  private segments: Segment[] = [];
  private index = 0;
  private opts: SpeakOptions | null = null;
  private generation = 0;
  state: TtsState = "idle";

  private setState(s: TtsState) {
    this.state = s;
    this.opts?.onStateChange?.(s);
  }

  start(segments: Segment[], opts: SpeakOptions) {
    // Some engines have no speech synthesis (WebKitGTK built without it).
    if (!ttsSupported()) return alert(t("tts.noVoices"));
    this.stop();
    this.opts = opts;
    this.segments = segments;
    this.index = 0;
    this.setState("playing");
    this.speakCurrent();
  }

  /** Changes rate/pitch/voice; takes effect from the current sentence. */
  update(patch: Partial<Pick<SpeakOptions, "rate" | "pitch" | "voice">>) {
    if (!this.opts) return;
    Object.assign(this.opts, patch);
    if (this.state === "playing") this.restartCurrent();
  }

  private restartCurrent() {
    this.generation++;
    speechSynthesis.cancel();
    this.speakCurrent();
  }

  private async speakCurrent() {
    const opts = this.opts;
    if (!opts) return;
    if (this.index >= this.segments.length) {
      const more = await opts.onEnd?.();
      if (!more || !more.length || this.opts !== opts) return this.stop();
      this.segments = more;
      this.index = 0;
    }
    const seg = this.segments[this.index];
    const gen = ++this.generation;
    const u = new SpeechSynthesisUtterance(seg.text);
    const all = await voices();
    const voice = all.find((v) => v.voiceURI === opts.voice) ?? all.find((v) => opts.lang && v.lang.startsWith(opts.lang));
    if (voice) u.voice = voice;
    if (opts.lang) u.lang = voice?.lang ?? opts.lang;
    u.rate = opts.rate;
    u.pitch = opts.pitch;
    u.onstart = () => gen === this.generation && opts.onSegment?.(this.index, seg);
    u.onend = () => {
      if (gen !== this.generation || this.state !== "playing") return;
      this.index++;
      this.speakCurrent();
    };
    u.onerror = (e) => {
      if (gen !== this.generation || e.error === "interrupted" || e.error === "canceled") return;
      this.index++;
      this.speakCurrent();
    };
    speechSynthesis.speak(u);
  }

  pause() {
    if (this.state !== "playing") return;
    speechSynthesis.pause();
    this.setState("paused");
  }

  resume() {
    if (this.state !== "paused") return;
    speechSynthesis.resume();
    this.setState("playing");
  }

  toggle() {
    if (this.state === "playing") this.pause();
    else if (this.state === "paused") this.resume();
  }

  skip(delta: number) {
    if (this.state === "idle") return;
    this.index = Math.max(0, Math.min(this.segments.length, this.index + delta));
    if (this.state === "paused") this.setState("playing");
    this.restartCurrent();
  }

  stop() {
    this.generation++;
    if (ttsSupported()) speechSynthesis.cancel();
    const opts = this.opts;
    this.opts = null;
    this.segments = [];
    this.index = 0;
    if (this.state !== "idle") {
      this.state = "idle";
      opts?.onStateChange?.("idle");
    }
  }
}
