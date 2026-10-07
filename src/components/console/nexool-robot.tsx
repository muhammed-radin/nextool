'use client';

/**
 * NexTool v1.0.14 §23.2 — the Assistant's cute robot centerpiece.
 * A polished, responsive SVG character whose EXPRESSION reflects the real
 * runtime state of the conversation task (idle / thinking / working /
 * waiting / asking / success / warning / error / confused / happy).
 * Pure SVG + CSS animations — no images, scales to any size.
 */

export type RobotMood =
  | 'idle'
  | 'thinking'
  | 'working'
  | 'waiting'
  | 'asking'
  | 'success'
  | 'warning'
  | 'error'
  | 'confused'
  | 'happy';

const MOOD_TONES: Record<RobotMood, { antenna: string; glow: string; accent: string }> = {
  idle: { antenna: '#38bdf8', glow: 'rgba(56,189,248,0.55)', accent: '#38bdf8' },
  thinking: { antenna: '#a78bfa', glow: 'rgba(167,139,250,0.6)', accent: '#a78bfa' },
  working: { antenna: '#38bdf8', glow: 'rgba(56,189,248,0.65)', accent: '#38bdf8' },
  waiting: { antenna: '#94a3b8', glow: 'rgba(148,163,184,0.45)', accent: '#94a3b8' },
  asking: { antenna: '#fbbf24', glow: 'rgba(251,191,36,0.6)', accent: '#fbbf24' },
  success: { antenna: '#34d399', glow: 'rgba(52,211,153,0.6)', accent: '#34d399' },
  happy: { antenna: '#34d399', glow: 'rgba(52,211,153,0.6)', accent: '#34d399' },
  warning: { antenna: '#fbbf24', glow: 'rgba(251,191,36,0.65)', accent: '#fbbf24' },
  error: { antenna: '#fb7185', glow: 'rgba(251,113,133,0.65)', accent: '#fb7185' },
  confused: { antenna: '#94a3b8', glow: 'rgba(148,163,184,0.5)', accent: '#94a3b8' },
};

export function RobotMoodLabel({ mood }: { mood: RobotMood }) {
  const labels: Record<RobotMood, string> = {
    idle: 'idle — listening for events',
    thinking: 'thinking…',
    working: 'working…',
    waiting: 'waiting — between cycles',
    asking: 'asking you something',
    success: 'done — all good',
    happy: 'happy to help',
    warning: 'needs attention',
    error: 'something failed',
    confused: 'not sure what to do',
  };
  return <span className="text-[11px] text-muted-foreground">{labels[mood]}</span>;
}

export function NexToolRobot({ mood = 'idle', size = 160 }: { mood?: RobotMood; size?: number }) {
  const tone = MOOD_TONES[mood] ?? MOOD_TONES.idle;

  // eyes per mood
  const eyes = (() => {
    if (mood === 'success' || mood === 'happy') {
      // happy squint arcs
      return (
        <>
          <path d="M74 104 q10 -10 20 0" stroke="#e2f3ff" strokeWidth="6" strokeLinecap="round" fill="none" />
          <path d="M126 104 q10 -10 20 0" stroke="#e2f3ff" strokeWidth="6" strokeLinecap="round" fill="none" />
        </>
      );
    }
    if (mood === 'error') {
      return (
        <>
          <path d="M76 96 l16 16 M92 96 l-16 16" stroke="#fecdd3" strokeWidth="5" strokeLinecap="round" />
          <path d="M128 96 l16 16 M144 96 l-16 16" stroke="#fecdd3" strokeWidth="5" strokeLinecap="round" />
        </>
      );
    }
    if (mood === 'confused') {
      return (
        <>
          <circle cx="84" cy="104" r="9" fill="#e2f3ff" className="robot-blink" />
          <circle cx="136" cy="100" r="12" fill="#e2f3ff" className="robot-blink" />
        </>
      );
    }
    if (mood === 'thinking') {
      return (
        <>
          <circle cx="78" cy="96" r="8" fill="#e2f3ff" />
          <circle cx="130" cy="94" r="8" fill="#e2f3ff" />
        </>
      );
    }
    if (mood === 'asking') {
      return (
        <>
          <circle cx="84" cy="102" r="11" fill="#e2f3ff" />
          <circle cx="136" cy="102" r="11" fill="#e2f3ff" />
          <circle cx="87" cy="98" r="3.5" fill="#0b1220" />
          <circle cx="139" cy="98" r="3.5" fill="#0b1220" />
        </>
      );
    }
    // idle / working / waiting / warning
    return (
      <>
        <circle cx="84" cy="104" r="9" fill="#e2f3ff" className="robot-blink" />
        <circle cx="136" cy="104" r="9" fill="#e2f3ff" className="robot-blink" />
        {mood === 'working' ? <><circle cx="86" cy="106" r="3.5" fill="#0b1220" /><circle cx="138" cy="106" r="3.5" fill="#0b1220" /></> : null}
      </>
    );
  })();

  // mouth per mood
  const mouth = (() => {
    if (mood === 'success' || mood === 'happy') {
      return <path d="M88 132 q22 18 44 0" stroke="#e2f3ff" strokeWidth="6" strokeLinecap="round" fill="none" />;
    }
    if (mood === 'error') {
      return <path d="M92 140 q18 -12 36 0" stroke="#fecdd3" strokeWidth="5" strokeLinecap="round" fill="none" />;
    }
    if (mood === 'warning' || mood === 'asking') {
      return <circle cx="110" cy="136" r="7" fill="none" stroke="#e2f3ff" strokeWidth="5" />;
    }
    if (mood === 'thinking') {
      return <path d="M96 136 q10 6 26 2" stroke="#e2f3ff" strokeWidth="5" strokeLinecap="round" fill="none" />;
    }
    if (mood === 'confused') {
      return <path d="M94 138 q14 -4 30 4" stroke="#e2f3ff" strokeWidth="5" strokeLinecap="round" fill="none" />;
    }
    // idle / working / waiting — soft smile
    return <path d="M94 130 q16 12 32 0" stroke="#e2f3ff" strokeWidth="5" strokeLinecap="round" fill="none" />;
  })();

  const bobClass = mood === 'working' ? 'robot-bob-fast' : mood === 'idle' || mood === 'waiting' ? 'robot-bob' : '';

  return (
    <div
      className={cnRobotWrap(bobClass)}
      style={{ width: size, height: size }}
      role="img"
      aria-label={`NexTool assistant robot — ${mood}`}
    >
      <svg viewBox="0 0 220 220" width={size} height={size} className="drop-shadow-[0_0_24px_rgba(56,189,248,0.12)]">
        <defs>
          <linearGradient id="robotBody" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#182c47" />
            <stop offset="100%" stopColor="#0d1a30" />
          </linearGradient>
          <linearGradient id="robotFace" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#0a1526" />
            <stop offset="100%" stopColor="#081020" />
          </linearGradient>
        </defs>

        {/* antenna */}
        <line x1="110" y1="28" x2="110" y2="52" stroke={tone.antenna} strokeWidth="4" strokeLinecap="round" opacity="0.8" />
        <circle cx="110" cy="22" r="8" fill={tone.antenna} className="robot-antenna">
          <animate attributeName="opacity" values="1;0.55;1" dur="2s" repeatCount="indefinite" />
        </circle>
        <circle cx="110" cy="22" r="14" fill="none" stroke={tone.glow} strokeWidth="1.5" opacity="0.5" />

        {/* ears */}
        <rect x="30" y="102" width="14" height="34" rx="7" fill="#16273f" stroke="rgba(255,255,255,0.08)" />
        <rect x="176" y="102" width="14" height="34" rx="7" fill="#16273f" stroke="rgba(255,255,255,0.08)" />

        {/* head */}
        <rect x="42" y="52" width="136" height="112" rx="30" fill="url(#robotBody)" stroke="rgba(255,255,255,0.12)" strokeWidth="1.5" />
        {/* face screen */}
        <rect x="56" y="66" width="108" height="84" rx="20" fill="url(#robotFace)" stroke="rgba(56,189,248,0.22)" strokeWidth="1" />

        {eyes}
        {mouth}

        {/* blush for happy moods */}
        {mood === 'success' || mood === 'happy' ? (
          <>
            <ellipse cx="66" cy="126" rx="8" ry="4.5" fill="rgba(251,113,133,0.35)" />
            <ellipse cx="154" cy="126" rx="8" ry="4.5" fill="rgba(251,113,133,0.35)" />
          </>
        ) : null}

        {/* body */}
        <rect x="66" y="168" width="88" height="34" rx="16" fill="#16273f" stroke="rgba(255,255,255,0.1)" />
        <circle cx="110" cy="185" r="7" fill="none" stroke={tone.accent} strokeWidth="2.5" opacity="0.85" />
      </svg>
    </div>
  );
}

function cnRobotWrap(extra?: string): string {
  return ['relative select-none', extra].filter(Boolean).join(' ');
}
