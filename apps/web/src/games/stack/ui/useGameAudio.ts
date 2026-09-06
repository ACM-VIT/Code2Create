import { useCallback, useEffect, useRef } from "react";

const MUSIC_URL = "/games/stack/audio/hot-springs-town.mp3";

type Tone = {
  from: number;
  to?: number;
  delay?: number;
  duration: number;
  volume: number;
  wave?: OscillatorType;
};

export function useGameAudio() {
  const contextRef = useRef<AudioContext | null>(null);
  const musicRef = useRef<HTMLAudioElement | null>(null);

  const getContext = useCallback(() => {
    if (typeof window === "undefined" || !window.AudioContext) return null;
    if (!contextRef.current) contextRef.current = new window.AudioContext();
    return contextRef.current;
  }, []);

  const playTones = useCallback((tones: readonly Tone[]) => {
    const context = getContext();
    if (!context) return;
    const startAt = context.currentTime;
    tones.forEach(({ from, to = from, delay = 0, duration, volume, wave = "sine" }) => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const toneStart = startAt + delay;
      oscillator.type = wave;
      oscillator.frequency.setValueAtTime(from, toneStart);
      oscillator.frequency.exponentialRampToValueAtTime(Math.max(1, to), toneStart + duration);
      gain.gain.setValueAtTime(0.0001, toneStart);
      gain.gain.exponentialRampToValueAtTime(volume, toneStart + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, toneStart + duration);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(toneStart);
      oscillator.stop(toneStart + duration + 0.02);
    });
  }, [getContext]);

  const startMusic = useCallback(() => {
    const context = getContext();
    if (!context) return;
    void context.resume();
    if (!musicRef.current) {
      const music = new Audio(MUSIC_URL);
      music.loop = true;
      music.volume = 0.14;
      music.preload = "auto";
      musicRef.current = music;
    }
    void musicRef.current.play().catch(() => undefined);
  }, [getContext]);

  const stopMusic = useCallback(() => musicRef.current?.pause(), []);

  useEffect(() => () => {
    musicRef.current?.pause();
    musicRef.current = null;
    void contextRef.current?.close();
  }, []);

  return {
    startMusic,
    stopMusic,
    playDrop: () => playTones([{ from: 330, to: 205, duration: 0.14, volume: 0.025, wave: "sine" }]),
    playLock: () => playTones([
      { from: 880, to: 880, duration: 0.24, volume: 0.035, wave: "sine" },
      { from: 1318, to: 1318, delay: 0.045, duration: 0.2, volume: 0.022, wave: "triangle" }
    ]),
    playLifeLost: () => playTones([{ from: 260, to: 110, duration: 0.42, volume: 0.045, wave: "sine" }])
  };
}
