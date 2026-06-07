/** exist 공용 아이콘 — PDF 디자인의 검정 미니멀 스타일 (currentColor 상속) */

interface IconProps {
  size?: number;
}

function Svg({ size = 18, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export function PhoneIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path
        d="M6.62 10.79a15.05 15.05 0 0 0 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1C10.61 21 3 13.39 3 4c0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z"
        fill="currentColor"
      />
    </Svg>
  );
}

export function ChatIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path
        d="M4 3h16c1.1 0 2 .9 2 2v11c0 1.1-.9 2-2 2H8.5L4 22V5c0-1.1.9-2 2-2z"
        fill="currentColor"
        transform="translate(-1 -1)"
      />
    </Svg>
  );
}

export function CalendarIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <rect x="3.2" y="5" width="17.6" height="16" rx="2" stroke="currentColor" strokeWidth="1.9" />
      <path d="M3.2 9.5h17.6" stroke="currentColor" strokeWidth="1.9" />
      <path d="M8 2.8v4M16 2.8v4" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
      <rect x="7" y="13" width="4" height="4" rx="0.8" fill="currentColor" />
    </Svg>
  );
}

export function GearIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path
        d="M19.14 12.94c.04-.3.06-.61.06-.94s-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.48.48 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.48.48 0 0 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32a.49.49 0 0 0-.12-.61l-2.01-1.58zM12 15.6A3.6 3.6 0 1 1 12 8.4a3.6 3.6 0 0 1 0 7.2z"
        fill="currentColor"
      />
    </Svg>
  );
}

export function ClockIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
      <path d="M12 7v5l3.5 2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </Svg>
  );
}

export function FolderIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path
        d="M3.5 6.5c0-1.1.9-2 2-2h4l2 2.2h7c1.1 0 2 .9 2 2v9c0 1.1-.9 2-2 2h-13c-1.1 0-2-.9-2-2v-11.2z"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

export function CheckIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <rect x="3.2" y="3.2" width="17.6" height="17.6" rx="4" stroke="currentColor" strokeWidth="1.9" />
      <path
        d="M7.5 12.2l3 3 6-6.5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

export function MicIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <rect x="9" y="2.5" width="6" height="11.5" rx="3" fill="currentColor" />
      <path
        d="M5.5 11.5a6.5 6.5 0 0 0 13 0"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path d="M12 18v3.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </Svg>
  );
}

export function CamIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <rect x="2.5" y="6" width="13" height="12" rx="2" fill="currentColor" />
      <path d="M16.5 11l5-3.8v9.6l-5-3.8v-2z" fill="currentColor" />
    </Svg>
  );
}

export function ScreenIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <rect x="2.5" y="4" width="19" height="13" rx="2" stroke="currentColor" strokeWidth="2" />
      <path d="M8.5 21h7M12 17.5V21" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </Svg>
  );
}

export function SlashIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M4 4l16 16" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
    </Svg>
  );
}
