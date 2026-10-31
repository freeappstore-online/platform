import type { CSSProperties } from 'react';
import type { UseVoiceInputReturn } from '../voice.js';

export interface VoiceButtonProps {
  voice: UseVoiceInputReturn;
  disabled?: boolean;
  size?: number;
}

/** Microphone toggle button. Shows red when listening. Hidden when unsupported. */
export function VoiceButton({ voice, disabled = false, size = 32 }: VoiceButtonProps) {
  if (!voice.isSupported) return null;

  const iconSize = Math.round(size * 0.5);

  return (
    <button
      type="button"
      onClick={voice.toggle}
      disabled={disabled}
      title={voice.isListening ? 'Stop listening' : 'Voice input'}
      className={[
        'rounded-full',
        'border-0',
        'flex',
        'items-center',
        'justify-center',
        disabled ? 'cursor-default' : 'cursor-pointer',
        disabled ? 'opacity-[0.4]' : 'opacity-[1]',
        voice.isListening ? 'bg-danger-soft' : 'bg-panel',
        voice.isListening ? 'text-danger' : 'text-muted',
        'font-[inherit]',
        'shrink-0',
      ]
        .filter(Boolean)
        .join(' ')}
      // Dynamic: Voice button dimensions follow the caller size prop.
      style={{ width: size, height: size }}
    >
      {voice.isListening ? <StopIcon size={iconSize} /> : <MicIcon size={iconSize} />}
    </button>
  );
}

function MicIcon({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="9" y="1" width="6" height="12" rx="3" />
      <path d="M5 10a7 7 0 0 0 14 0" />
      <line x1="12" y1="17" x2="12" y2="21" />
      <line x1="8" y1="21" x2="16" y2="21" />
    </svg>
  );
}

function StopIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <rect x="4" y="4" width="16" height="16" rx="2" />
    </svg>
  );
}

export interface VoiceTextAreaProps {
  value: string;
  onChange: (value: string) => void;
  voice: UseVoiceInputReturn;
  placeholder?: string;
  disabled?: boolean;
  rows?: number;
  onSubmit?: () => void;
  style?: CSSProperties;
}

/** Textarea with integrated voice button. Shows interim transcript while listening. */
export function VoiceTextArea({
  value,
  onChange,
  voice,
  placeholder = 'Type or speak...',
  disabled = false,
  rows = 3,
  onSubmit,
  style: extraStyle,
}: VoiceTextAreaProps) {
  // Show interim transcript appended to real value, but never write it
  // back via onChange — that would double-insert when onResult fires.
  const displayValue =
    voice.isListening && voice.transcript ? value + (value ? ' ' : '') + voice.transcript : value;

  const displayPlaceholder = voice.isListening ? 'Listening...' : placeholder;

  return (
    <div
      className="relative"
      // Dynamic: Caller-supplied appearance remains supported for compatibility; prefer className.
      style={{ ...extraStyle }}
    >
      <textarea
        value={displayValue}
        onChange={(e) => {
          // While listening, ignore onChange — the displayed value includes
          // interim transcript that shouldn't be committed to state.
          if (!voice.isListening) onChange(e.currentTarget.value);
        }}
        placeholder={displayPlaceholder}
        disabled={disabled}
        readOnly={voice.isListening}
        rows={rows}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && onSubmit && !voice.isListening) {
            e.preventDefault();
            onSubmit();
          }
        }}
        className={[
          'w-full',
          voice.isSupported ? 'p-[0.75rem_3rem_0.75rem_0.75rem]' : 'p-3',
          'rounded',
          voice.isListening ? 'border-2 border-danger' : 'border border-line',
          'bg-panel',
          'text-ink',
          'text-[0.9rem]',
          'font-[inherit]',
          'resize-y',
          'outline-none',
          'box-border',
        ]
          .filter(Boolean)
          .join(' ')}
      />
      {voice.isSupported && (
        <div className="absolute right-2 bottom-2">
          <VoiceButton voice={voice} disabled={disabled} />
        </div>
      )}
    </div>
  );
}
