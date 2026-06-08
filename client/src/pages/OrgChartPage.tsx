import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { useOrgStore } from '../orgStore';
import Logo from '../components/Logo';
import { BuildingIcon, UsersIcon } from '../components/Icons';
import { POSITIONS } from '../lib/positions';

interface Member {
  userId: number;
  username: string;
  avatar: string;
  role: 'owner' | 'admin' | 'member';
  position: string | null;
  department: string | null;
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

const ROLE_LABEL: Record<string, string> = { owner: '소유자', admin: '관리자', member: '멤버' };

/** 부서별 그룹 — 부서 있는 그룹 먼저(가나다), 미지정 마지막. 그룹 내 직급 높은 순 */
function groupByDept(members: Member[]): { dept: string | null; people: Member[] }[] {
  const map = new Map<string | null, Member[]>();
  for (const m of members) {
    const key = m.department || null;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(m);
  }
  const rank = (p: string | null) => (p ? POSITIONS.indexOf(p as (typeof POSITIONS)[number]) : -1);
  return [...map.entries()]
    .map(([dept, people]) => ({
      dept,
      people: [...people].sort((a, b) => rank(b.position) - rank(a.position)),
    }))
    .sort((a, b) => {
      if (a.dept === null) return 1;
      if (b.dept === null) return -1;
      return a.dept.localeCompare(b.dept, 'ko');
    });
}

/** 조직도 = 조직 운영 통합 화면 (보기 + 가입 승인 + 직급/부서/역할/제거 관리) */
export default function OrgChartPage() {
  const { id } = useParams();
  const orgId = Number(id);
  const navigate = useNavigate();
  const reloadOrgs = useOrgStore((s) => s.load);
  const [detail, setDetail] = useState<OrgDetail | null>(null);
  const [copied, setCopied] = useState(false);
  // 승인 전 입력할 직급·부서 (대기자 userId별)
  const [draft, setDraft] = useState<Record<number, { position: string; department: string }>>({});

  const load = useCallback(async () => {
    try {
      setDetail(await api<OrgDetail>(`/api/orgs/${orgId}`));
    } catch {
      navigate('/');
    }
  }, [orgId, navigate]);

  useEffect(() => {
    void load();
  }, [load]);

  async function refresh() {
    await load();
    await reloadOrgs();
  }

  function setDraft_(userId: number, patch: Partial<{ position: string; department: string }>) {
    setDraft((prev) => {
      const cur = prev[userId] ?? { position: '', department: '' };
      return { ...prev, [userId]: { ...cur, ...patch } };
    });
  }

  async function approve(userId: number) {
    const d = draft[userId];
    await api(`/api/orgs/${orgId}/members/${userId}/approve`, {
      method: 'POST',
      body: { position: d?.position || null, department: d?.department || null },
    });
    await refresh();
  }
  async function remove(userId: number) {
    await api(`/api/orgs/${orgId}/members/${userId}`, { method: 'DELETE' });
    await refresh();
  }
  async function setRole(userId: number, role: 'admin' | 'member') {
    await api(`/api/orgs/${orgId}/members/${userId}`, { method: 'PATCH', body: { role } });
    await load();
  }
  async function setPosition(userId: number, position: string) {
    await api(`/api/orgs/${orgId}/members/${userId}`, {
      method: 'PATCH',
      body: { position: position || null },
    });
    await load();
  }
  async function setDepartment(userId: number, department: string) {
    await api(`/api/orgs/${orgId}/members/${userId}`, {
      method: 'PATCH',
      body: { department: department || null },
    });
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

  const groups = detail ? groupByDept(detail.members) : [];
  const manager = !!detail?.isManager;
  const owner = detail?.myRole === 'owner';

  return (
    <div className="orgchart-page">
      <header className="orgchart-top">
        <button className="orgchart-back" onClick={() => navigate('/')} title="대시보드로">
          ‹ 대시보드
        </button>
        <Logo />
        <span />
      </header>

      {!detail ? (
        <div className="orgchart-loading">조직도를 불러오는 중…</div>
      ) : (
        <main className="orgchart-main">
          <div className="orgchart-header">
            <div className="orgchart-title">
              <span className="orgchart-icon">
                <BuildingIcon size={26} />
              </span>
              <div>
                <h1>{detail.name}</h1>
                <div className="orgchart-sub">
                  <UsersIcon size={14} /> 멤버 {detail.members.length}명 · 부서{' '}
                  {groups.filter((g) => g.dept).length}개
                </div>
              </div>
            </div>
            {manager && detail.joinCode && (
              <button className="orgchart-code" onClick={copyCode} title="가입코드 복사">
                가입코드 <b>{detail.joinCode}</b> {copied ? '✓' : ''}
              </button>
            )}
          </div>

          {/* 가입 대기 — 관리자만, 직급·부서 미리 정하며 승인 */}
          {manager && detail.pending.length > 0 && (
            <section className="orgchart-pending">
              <div className="orgchart-pending-head">
                ✉️ 가입 대기 <b>{detail.pending.length}</b>
              </div>
              {detail.pending.map((p) => (
                <div key={p.userId} className="orgchart-pending-row">
                  <span className="orgchart-pending-id">
                    <span className="orgchart-avatar sm">{p.avatar || '🙂'}</span>
                    {p.username}
                  </span>
                  <select
                    className="org-field-select"
                    value={draft[p.userId]?.position ?? ''}
                    onChange={(e) => setDraft_(p.userId, { position: e.target.value })}
                    title="직급 (선택)"
                  >
                    <option value="">직급 미지정</option>
                    {POSITIONS.map((pos) => (
                      <option key={pos} value={pos}>
                        {pos}
                      </option>
                    ))}
                  </select>
                  <input
                    className="org-field-input"
                    value={draft[p.userId]?.department ?? ''}
                    placeholder="부서 (선택)"
                    maxLength={30}
                    onChange={(e) => setDraft_(p.userId, { department: e.target.value })}
                  />
                  <span className="orgchart-pending-actions">
                    <button className="org-btn approve" onClick={() => approve(p.userId)}>
                      승인
                    </button>
                    <button className="org-btn reject" onClick={() => remove(p.userId)}>
                      거절
                    </button>
                  </span>
                </div>
              ))}
            </section>
          )}

          <div className="orgchart-grid">
            {groups.map((g) => (
              <section key={g.dept ?? '__none'} className="orgchart-dept">
                <div className="orgchart-dept-head">
                  {g.dept ?? '부서 미지정'}
                  <span className="orgchart-dept-count">{g.people.length}</span>
                </div>
                <div className="orgchart-members">
                  {g.people.map((m) => (
                    <div key={m.userId} className={`orgchart-card${manager ? ' editable' : ''}`}>
                      <div className="orgchart-card-main">
                        <span className="orgchart-avatar">{m.avatar || '🙂'}</span>
                        <div className="orgchart-info">
                          <div className="orgchart-name">
                            {m.username}
                            {m.role !== 'member' && (
                              <span className={`org-role ${m.role}`}>{ROLE_LABEL[m.role]}</span>
                            )}
                          </div>
                          <div className="orgchart-pos">
                            {m.position ?? '직급 미지정'}
                            {m.department && ` · ${m.department}`}
                          </div>
                        </div>
                      </div>

                      {/* 관리자 인라인 편집 (소유자 대상 제외) */}
                      {manager && m.role !== 'owner' && (
                        <div className="orgchart-card-edit">
                          <select
                            className="org-field-select"
                            value={m.position ?? ''}
                            onChange={(e) => setPosition(m.userId, e.target.value)}
                            title="직급"
                          >
                            <option value="">직급 미지정</option>
                            {POSITIONS.map((pos) => (
                              <option key={pos} value={pos}>
                                {pos}
                              </option>
                            ))}
                            {m.position &&
                              !POSITIONS.includes(m.position as (typeof POSITIONS)[number]) && (
                                <option value={m.position}>{m.position}</option>
                              )}
                          </select>
                          <input
                            key={`dep-${m.userId}-${m.department ?? ''}`}
                            className="org-field-input"
                            defaultValue={m.department ?? ''}
                            placeholder="부서"
                            maxLength={30}
                            title="부서"
                            onBlur={(e) => {
                              if ((e.target.value || '') !== (m.department ?? '')) {
                                void setDepartment(m.userId, e.target.value);
                              }
                            }}
                          />
                          {owner &&
                            (m.role === 'member' ? (
                              <button className="org-btn" onClick={() => setRole(m.userId, 'admin')}>
                                관리자로
                              </button>
                            ) : (
                              <button className="org-btn" onClick={() => setRole(m.userId, 'member')}>
                                멤버로
                              </button>
                            ))}
                          <button className="org-btn reject" onClick={() => remove(m.userId)}>
                            제거
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </section>
            ))}
          </div>
        </main>
      )}
    </div>
  );
}
