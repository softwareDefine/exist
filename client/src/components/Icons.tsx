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
      {/* 뒤 말풍선 (받는 쪽) */}
      <path
        d="M3 6.2A2.2 2.2 0 0 1 5.2 4h8.6A2.2 2.2 0 0 1 16 6.2v3.6A2.2 2.2 0 0 1 13.8 12H8l-3 2.6V12h-.8a1.2 1.2 0 0 1-1.2-1.2V6.2z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
        fill="#fff"
      />
      {/* 앞 말풍선 (보내는 쪽) — 겹쳐서 대화 느낌 */}
      <path
        d="M9 13.2A1.8 1.8 0 0 1 10.8 11.4h7.4A1.8 1.8 0 0 1 20 13.2v3A1.8 1.8 0 0 1 18.2 18H18v2.2L15.2 18h-4.4A1.8 1.8 0 0 1 9 16.2v-3z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
        fill="#fff"
      />
    </Svg>
  );
}

export function CalendarIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <rect x="3.3" y="5" width="17.4" height="15.7" rx="2.5" stroke="currentColor" strokeWidth="1.8" />
      <path d="M3.3 9.3h17.4" stroke="currentColor" strokeWidth="1.8" />
      <path d="M8 3v3.4M16 3v3.4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="8" cy="13" r="1.1" fill="currentColor" />
      <circle cx="12" cy="13" r="1.1" fill="currentColor" />
      <circle cx="16" cy="13" r="1.1" fill="currentColor" />
      <circle cx="8" cy="16.8" r="1.1" fill="currentColor" />
      <circle cx="12" cy="16.8" r="1.1" fill="currentColor" />
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

export function ExpandIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path
        d="M14 3h7v7M10 21H3v-7M21 3l-8 8M3 21l8-8"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

export function ShrinkIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path
        d="M20 10h-6V4M4 14h6v6M14 10l7-7M10 14l-7 7"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

export function CloseIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path
        d="M6 6l12 12M18 6L6 18"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
    </Svg>
  );
}

export function BuildingIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <rect x="4" y="3" width="11" height="18" rx="1.5" stroke="currentColor" strokeWidth="1.8" />
      <path d="M15 8h4a1.5 1.5 0 0 1 1.5 1.5V21" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      <path
        d="M7.5 7h4M7.5 10.5h4M7.5 14h4M17.5 11.5h.01M17.5 15h.01"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </Svg>
  );
}

export function UsersIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <circle cx="9" cy="8" r="3.2" stroke="currentColor" strokeWidth="1.8" />
      <path d="M3.5 19.5a5.5 5.5 0 0 1 11 0" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path
        d="M16 5.2a3.2 3.2 0 0 1 0 5.6M17.5 14.2a5.5 5.5 0 0 1 3 5.3"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </Svg>
  );
}

export function ChevronIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

export function PlusIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
    </Svg>
  );
}

export function GridIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.6" stroke="currentColor" strokeWidth="1.9" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.6" stroke="currentColor" strokeWidth="1.9" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.6" stroke="currentColor" strokeWidth="1.9" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.6" stroke="currentColor" strokeWidth="1.9" />
    </Svg>
  );
}

export function PenIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path
        d="M14.5 5.5l4 4M4 20l1-4L16 5a2.1 2.1 0 0 1 3 3L8 19l-4 1z"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </Svg>
  );
}

export function BellIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path
        d="M18.5 9a6.5 6.5 0 0 0-13 0c0 6-2.5 7.5-2.5 7.5h18S18.5 15 18.5 9z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M10 20.5a2.3 2.3 0 0 0 4 0"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </Svg>
  );
}

export function PanelLeftIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <rect x="3" y="4.5" width="18" height="15" rx="2.5" stroke="currentColor" strokeWidth="1.9" />
      <path d="M9 4.5v15" stroke="currentColor" strokeWidth="1.9" />
    </Svg>
  );
}

export function HistoryIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path
        d="M3.5 8.5a9 9 0 1 1-1.2 4.5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path d="M3 4v4.5h4.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12 8v4.2l2.8 1.8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

export function DocIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M6 3h8l4 4v14H6z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      <path d="M13.5 3.2V7.5H18" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      <path d="M9 12.5h6M9 16h6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </Svg>
  );
}

export function CodeIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M8.5 8.5L4 12l4.5 3.5" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M15.5 8.5L20 12l-4.5 3.5" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M13.5 5.5l-3 13" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
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
