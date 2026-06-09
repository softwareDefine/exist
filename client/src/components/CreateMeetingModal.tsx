import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useOrgStore, type OrgContext } from '../orgStore';
import { CloseIcon, CalendarIcon, CopyIcon, CheckMarkIcon, BuildingIcon } from './Icons';

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}

export default function CreateMeetingModal({ open, onClose, onCreated }: Props) {
  const navigate = useNavigate();
  const orgs = useOrgStore((s) => s.orgs);
  const current = useOrgStore((s) => s.current);
  const [title, setTitle] = useState('');
  const [orgCtx, setOrgCtx] = useState<OrgContext>('personal');
  const [schedOn, setSchedOn] = useState(false);
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [created, setCreated] = useState<{ code: string; title: string } | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTitle('');
    setOrgCtx(current);
    setSchedOn(false);
    setStart('');
    setEnd('');
    setCreated(null);
    setCopied(false);
  }, [open, current]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    try {
      const m = await api<{ code: string; title: string }>('/api/meetings', {
        method: 'POST',
        body: {
          title,
          org_id: orgCtx === 'personal' ? null : orgCtx,
          starts_at: schedOn ? start || null : null,
          ends_at: schedOn ? end || null : null,
        },
      });
      setCreated({ code: m.code, title });
      onCreated();
    } catch {
      /* 전역 에러 토스트 */
    }
  }

  async function copyCode() {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* 수동 복사 */
    }
  }

  return (
    <div className="cm-overlay" onClick={onClose}>
      <div className="cm-modal" onClick={(e) => e.stopPropagation()}>
        {created ? (
          <div className="cm-done">
            <div className="cm-done-emoji">🎉</div>
            <h2 className="cm-done-title">회의가 만들어졌어요</h2>
            <p className="cm-done-sub">팀원에게 코드를 공유하면 바로 참여할 수 있어요</p>
            <button className="cm-code" onClick={copyCode} title="클릭해서 복사">
              <span className="cm-code-val">{created.code}</span>
              <span className="cm-code-copy">
                {copied ? <CheckMarkIcon size={18} /> : <CopyIcon size={18} />}
              </span>
            </button>
            <div className="cm-footer">
              <button className="cm-btn ghost" onClick={onClose}>
                닫기
              </button>
              <button className="cm-btn primary" onClick={() => navigate(`/meeting/${created.code}`)}>
                지금 입장 →
              </button>
            </div>
          </div>
        ) : (
          <form className="cm-form" onSubmit={submit}>
            <div className="cm-header">
              <div className="cm-header-ic">
                <CalendarIcon size={22} />
              </div>
              <div className="cm-header-text">
                <h2>새 회의 만들기</h2>
                <p>팀과 함께할 공간을 만들어요</p>
              </div>
              <button type="button" className="cm-x" onClick={onClose}>
                <CloseIcon size={18} />
              </button>
            </div>

            <div className="cm-body">
              <div className="cm-field">
                <span className="cm-field-label">회의 이름</span>
                <input
                  className="cm-input"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="예: 주간 스프린트 리뷰"
                  autoFocus
                />
              </div>

              <div className="cm-field">
                <span className="cm-field-label">어디에 만들까요?</span>
                <div className="cm-orgs">
                  <button
                    type="button"
                    className={`cm-org${orgCtx === 'personal' ? ' on' : ''}`}
                    onClick={() => setOrgCtx('personal')}
                  >
                    <span className="cm-org-ic personal">👤</span>
                    <span className="cm-org-name">개인 회의</span>
                  </button>
                  {orgs.map((o) => (
                    <button
                      type="button"
                      key={o.id}
                      className={`cm-org${orgCtx === o.id ? ' on' : ''}`}
                      onClick={() => setOrgCtx(o.id)}
                    >
                      <span className="cm-org-ic">
                        <BuildingIcon size={17} />
                      </span>
                      <span className="cm-org-name">{o.name}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="cm-field">
                <button
                  type="button"
                  className="cm-sched-toggle"
                  onClick={() => setSchedOn((v) => !v)}
                >
                  <span className="cm-sched-label">
                    <CalendarIcon size={15} /> 일정 잡기
                    <span className="cm-sched-opt">선택</span>
                  </span>
                  <span className={`cm-switch${schedOn ? ' on' : ''}`}>
                    <i />
                  </span>
                </button>
                {schedOn && (
                  <div className="cm-sched">
                    <label className="cm-sched-row">
                      <span>시작</span>
                      <input
                        type="datetime-local"
                        value={start}
                        onChange={(e) => setStart(e.target.value)}
                      />
                    </label>
                    <label className="cm-sched-row">
                      <span>종료</span>
                      <input
                        type="datetime-local"
                        value={end}
                        onChange={(e) => setEnd(e.target.value)}
                      />
                    </label>
                  </div>
                )}
              </div>
            </div>

            <div className="cm-footer">
              <button type="button" className="cm-btn ghost" onClick={onClose}>
                취소
              </button>
              <button type="submit" className="cm-btn primary" disabled={!title.trim()}>
                회의 만들기
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
