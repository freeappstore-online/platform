export interface KeyStatus {
  color: string;
  label: string;
}

/** Provider/model/voice/key state shared by the toolbar + mobile bar + settings panel. */
export interface StudioSettings {
  provider: string;
  setProvider: (v: string) => void;
  model: string;
  setModel: (v: string) => void;
  temperature: number;
  setTemperature: (v: number) => void;
  keyReady: boolean;
  keyStatus: KeyStatus;
  voiceEnabled: boolean;
  voiceSupported: boolean;
  setVoiceEnabled: (v: boolean) => void;
}
