import { useCallback, useEffect, useRef, useState } from "react";

const ENABLED_KEY = "fas_voice_enabled";
const VOICE_KEY = "fas_voice_uri";
const AUTOSPEAK_KEY = "fas_voice_autospeak";

export function isSpeechSupported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window && "SpeechSynthesisUtterance" in window;
}

export interface SpeechState {
  enabled: boolean;
  supported: boolean;
  speakingId: string | null;
  autoSpeak: boolean;
  voices: SpeechSynthesisVoice[];
  voiceURI: string | null;
  setEnabled: (v: boolean) => void;
  setAutoSpeak: (v: boolean) => void;
  setVoiceURI: (uri: string | null) => void;
  speak: (id: string, text: string) => void;
  cancel: () => void;
}

export function useSpeech(): SpeechState {
  const supported = isSpeechSupported();
  const [enabled, setEnabledState] = useState<boolean>(() => supported && localStorage.getItem(ENABLED_KEY) === "1");
  const [autoSpeak, setAutoSpeakState] = useState<boolean>(() => supported && localStorage.getItem(AUTOSPEAK_KEY) === "1");
  const [voiceURI, setVoiceURIState] = useState<string | null>(() => localStorage.getItem(VOICE_KEY));
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [speakingId, setSpeakingId] = useState<string | null>(null);
  const speakingIdRef = useRef<string | null>(null);
  speakingIdRef.current = speakingId;
  const primedRef = useRef(false);

  // The voice list populates asynchronously in most browsers.
  useEffect(() => {
    if (!supported) return;
    const load = () => setVoices(window.speechSynthesis.getVoices());
    load();
    window.speechSynthesis.addEventListener("voiceschanged", load);
    return () => window.speechSynthesis.removeEventListener("voiceschanged", load);
  }, [supported]);

  const prime = useCallback(() => {
    if (!supported || primedRef.current) return;
    // iOS Safari blocks the FIRST speechSynthesis.speak() of a session unless
    // it's initiated from a user gesture. A silent utterance inside the gesture
    // handler unblocks the engine for later taps. Harmless elsewhere.
    try {
      const u = new SpeechSynthesisUtterance(" ");
      u.volume = 0;
      window.speechSynthesis.speak(u);
      primedRef.current = true;
    } catch {
      // ignore — primed flag stays false, we'll try again next gesture
    }
  }, [supported]);

  const setEnabled = useCallback((v: boolean) => {
    setEnabledState(v);
    if (supported) localStorage.setItem(ENABLED_KEY, v ? "1" : "0");
    if (v && supported) prime();
    if (!v && supported) {
      window.speechSynthesis.cancel();
      setSpeakingId(null);
    }
  }, [supported, prime]);

  const setAutoSpeak = useCallback((v: boolean) => {
    setAutoSpeakState(v);
    if (supported) localStorage.setItem(AUTOSPEAK_KEY, v ? "1" : "0");
  }, [supported]);

  const setVoiceURI = useCallback((uri: string | null) => {
    setVoiceURIState(uri);
    if (uri) localStorage.setItem(VOICE_KEY, uri);
    else localStorage.removeItem(VOICE_KEY);
  }, []);

  const cancel = useCallback(() => {
    if (!supported) return;
    window.speechSynthesis.cancel();
    setSpeakingId(null);
  }, [supported]);

  // Stop any in-flight speech when the component tree unmounts.
  useEffect(() => () => { if (supported) window.speechSynthesis.cancel(); }, [supported]);

  // Explicit per-message speak: works on tap regardless of `enabled` (that flag
  // gates only auto-speak-on-completion, checked by the caller).
  const speak = useCallback((id: string, text: string) => {
    if (!supported) return;
    const clean = stripForSpeech(text);
    if (!clean) return;
    // Re-tapping the currently-speaking bubble cancels (toggle).
    if (speakingIdRef.current === id) {
      window.speechSynthesis.cancel();
      setSpeakingId(null);
      return;
    }
    if (!primedRef.current) prime();
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(clean);
    const chosen = voiceURI ? window.speechSynthesis.getVoices().find((v) => v.voiceURI === voiceURI) : null;
    if (chosen) utter.voice = chosen;
    utter.lang = chosen?.lang || "en-US";
    utter.rate = 1.05;
    utter.onstart = () => setSpeakingId(id);
    utter.onend = () => setSpeakingId((prev) => (prev === id ? null : prev));
    utter.onerror = () => setSpeakingId((prev) => (prev === id ? null : prev));
    window.speechSynthesis.speak(utter);
  }, [supported, prime, voiceURI]);

  return {
    enabled, supported, speakingId, autoSpeak, voices, voiceURI,
    setEnabled, setAutoSpeak, setVoiceURI, speak, cancel,
  };
}

/** Convert markdown to a plain-text form that reads naturally aloud. */
function stripForSpeech(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, ". code block. ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}
