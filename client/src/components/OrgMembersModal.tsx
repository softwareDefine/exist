import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { useOrgStore } from '../orgStore';

interface Member {
  userId: number;
  username: string;
  avatar: string;
  role: 'owner' | 'admin' | 'member';
}
interface Pending {
  userId: number;
  username: string;
  avatar: string;
}
interface OrgDetail {
  id: number;
  name: string;
  joinCode?: string;
  ownerId: number;
  myRole: 'owner' | 'admin' | 'member';
  isManager: boolean;
  members: Member[];
  pending: Pending[];
}

interface Props {
  orgId: number | null;
  onClose: () => void;
}

const ROLE_LABEL: Record<string, string> = { owner: '소유자', admin: '관리자', member: '멤버' };

/** 조직 멤버 관리 — 가입 신청 승인/거절, 멤버 역할 변경·제거, 가입코드 공유 */
export default function OrgMembersModal({ orgId, onClose }: Props) {
  const reloadOrgs = useOrgStore((s) => s.load);
  const [detail, setDetail] = useState<OrgDetail | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    if (orgId == null) return;
    try {
      setDetail(await api<OrgDetail>(`/api/orgs/${orgId}`));
    } catch {
      onClose();
    }
  }, [orgId, onClose]);

  useEffect(() => {
    if (orgId == null) return;
    setDetail(null);
    void load();
  }, [orgId, load]);

  useEffect(() => {
    if (orgId == null) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [orgId, onClose]);

  if (orgId == null) return null;

  async function approve(userId: number) {
    await api(`/api/orgs/${orgId}/members/${userId}/approve`, { method: 'POST' });
    await load();
    await reloadOrgs();
  }
  async function remove(userId: number) {
    await api(`/api/orgs/${orgId}/members/${userId}`, { method: 'DELETE' });
    await load();
    await reloadOrgs();
  }
  async function setRole(userId: number, role: 'admin' | 'member') {
    await api(`/api/orgs/${orgId}/members/${userId}`, { method: 'PATCH', body: { role } });
    await load();
  }
  async function copyCode() {
    if (!detail?.joinCode) return;
    try {
      await navigator.clipboard.writeText(detail.joinCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* 수동 */
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card org-members" onClick={(e) => e.stopPropagation()}>
        {!detail ? (
          <div className="modal-head">불러오는 중…</div>
        ) : (
          <>
            <div className="modal-head">{detail.name} 멤버</div>

            {detail.isManager && detail.joinCode && (
              <div className="org-joincode">
                <span className="org-joincode-label">가입코드</span>
                <button className="org-joincode-val" onClick={copyCode} title="클릭해서 복사">
                  {detail.joinCode} {copied ? '✓' : ''}
                </button>
              </div>
            )}

            {detail.isManager && detail.pending.length > 0 && (
              <div className="org-section">
                <div className="org-section-title">가입 대기 ({detail.pending.length})</div>
                {detail.pending.map((p) => (
                  <div key={p.userId} className="org-member-row">
                    <span className="org-member-id">
                      <span className="org-avatar">{p.avatar}</span>
                      {p.username}
                    </span>
                    <span className="org-member-actions">
                      <button className="org-btn approve" onClick={() => approve(p.userId)}>
                        승인
                      </button>
                      <button className="org-btn reject" onClick={() => remove(p.userId)}>
                        거절
                      </button>
                    </span>
                  </div>
                ))}
              </div>
            )}

            <div className="org-section">
              <div className="org-section-title">멤버 ({detail.members.length})</div>
              {detail.members.map((m) => (
                <div key={m.userId} className="org-member-row">
                  <span className="org-member-id">
                    <span className="org-avatar">{m.avatar}</span>
                    {m.username}
                    <span className={`org-role ${m.role}`}>{ROLE_LABEL[m.role]}</span>
                  </span>
                  {/* 소유자만 역할 변경·제거 가능, 자기 자신/소유자 대상 제외 */}
                  {detail.myRole === 'owner' && m.role !== 'owner' && (
                    <span className="org-member-actions">
                      {m.role === 'member' ? (
                        <button className="org-btn" onClick={() => setRole(m.userId, 'admin')}>
                          관리자로
                        </button>
                      ) : (
                        <button className="org-btn" onClick={() => setRole(m.userId, 'member')}>
                          멤버로
                        </button>
                      )}
                      <button className="org-btn reject" onClick={() => remove(m.userId)}>
                        제거
                      </button>
                    </span>
                  )}
                </div>
              ))}
            </div>

            <div className="modal-actions">
              <button className="modal-primary" onClick={onClose}>
                닫기
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
