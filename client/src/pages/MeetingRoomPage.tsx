import { useNavigate, useParams } from 'react-router-dom';
import MeetingView from '../components/MeetingView';

/** 전체화면 회의 — 실제 로직은 MeetingView (대시보드 탭 임베드와 공용) */
export default function MeetingRoomPage() {
  const { code } = useParams<{ code: string }>();
  const navigate = useNavigate();

  if (!code) return null;

  return (
    <MeetingView
      code={code}
      onLeave={(message) => navigate('/', message ? { state: { message } } : undefined)}
    />
  );
}
