import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import Logo from '../components/Logo';
import OrgMembersModal from '../components/OrgMembersModal';
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
interface OrgDetail {
  id: number;
  name: string;
  joinCode?: string;
  ownerId: number;
  myRole: 'owner' | 'admin' | 'member';
  isManager: boolean;
  members: Member[];
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

export default function OrgChartPage() {
  const { id } = useParams();
  const orgId = Number(id);
  const navigate = useNavigate();
  const [detail, setDetail] = useState<OrgDetail | null>(null);
  const [manageOpen, setManageOpen] = useState(false);
  const [copied, setCopied] = useState(false);

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
            {detail.isManager && (
              <div className="orgchart-admin">
                {detail.joinCode && (
                  <button className="orgchart-code" onClick={copyCode} title="가입코드 복사">
                    가입코드 <b>{detail.joinCode}</b> {copied ? '✓' : ''}
                  </button>
                )}
                <button className="orgchart-manage" onClick={() => setManageOpen(true)}>
                  멤버 관리
                </button>
              </div>
            )}
          </div>

          <div className="orgchart-grid">
            {groups.map((g) => (
              <section key={g.dept ?? '__none'} className="orgchart-dept">
                <div className="orgchart-dept-head">
                  {g.dept ?? '부서 미지정'}
                  <span className="orgchart-dept-count">{g.people.length}</span>
                </div>
                <div className="orgchart-members">
                  {g.people.map((m) => (
                    <div key={m.userId} className="orgchart-card">
                      <span className="orgchart-avatar">{m.avatar || '🙂'}</span>
                      <div className="orgchart-info">
                        <div className="orgchart-name">
                          {m.username}
                          {m.role !== 'member' && (
                            <span className={`org-role ${m.role}`}>{ROLE_LABEL[m.role]}</span>
                          )}
                        </div>
                        <div className="orgchart-pos">{m.position ?? '직급 미지정'}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            ))}
          </div>
        </main>
      )}

      <OrgMembersModal
        orgId={manageOpen ? orgId : null}
        onClose={() => {
          setManageOpen(false);
          void load();
        }}
      />
    </div>
  );
}
