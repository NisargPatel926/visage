import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { currentUser } from '../../../../server/auth/currentUser';
import { isStaff, withTenant } from '../../../../server/db/tenant';
import { getIntake } from '../../../../server/repositories/intake';
import { getChecklist } from '../../../../server/repositories/checklist';
import { profileFromAnswers, overflowFromAnswers } from '../../../../domain/forms/profile';
import { I485_MAPPING } from '../../../../domain/forms/i485';

export const dynamic = 'force-dynamic';

export default async function CaseDetail({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await currentUser();
  if (!ctx) redirect('/login');
  if (!isStaff(ctx)) redirect('/portal');

  const { id } = await params;

  const data = await withTenant(ctx, async (tx) => {
    const kase = await tx.case.findUnique({ where: { id } });
    if (!kase) return null;
    return {
      kase,
      intake: await getIntake(tx, id),
      checklist: await getChecklist(tx, id),
      documents: await tx.document.findMany({
        where: { caseId: id }, orderBy: { createdAt: 'desc' },
      }),
      audit: await tx.auditEvent.findMany({
        where: { caseId: id }, orderBy: { at: 'desc' }, take: 8,
      }),
    };
  });
  if (!data) notFound();

  const profile = profileFromAnswers(data.intake.answers);
  const overflow = overflowFromAnswers(data.intake.answers);
  const known = Object.entries(profile).filter(([, v]) => v);

  return (
    <>
      <nav className="bar">
        <strong>Visage</strong>
        <Link href="/console">Cases</Link>
        <span className="spacer" />
        <span style={{ color: 'var(--muted)' }}>{data.kase.caseNumber}</span>
      </nav>

      <div className="wrap">
        <h1>{data.kase.caseNumber}</h1>
        <p className="lede">
          Intake {data.intake.progress.percent}% · {data.checklist.length} checklist items ·{' '}
          {data.documents.length} document{data.documents.length === 1 ? '' : 's'}
        </p>

        <div className="card">
          <h3>Form I-485</h3>
          <p className="help">
            Edition {I485_MAPPING.edition} · draft generated from the profile below.
            Nothing is filed until you approve it.
          </p>
          <p className="help">
            {known.length} profile field{known.length === 1 ? '' : 's'} known
            {overflow.length > 0 && ` · ${overflow.length} continuation${overflow.length === 1 ? '' : 's'} for Part 14`}
          </p>
          <a href={`/api/forms/i485?case=${data.kase.id}`} target="_blank" rel="noreferrer">
            <button type="button" style={{ marginTop: 6 }}>Open filled I-485 (draft)</button>
          </a>
        </div>

        <h2>Profile</h2>
        <div className="card" style={{ padding: 0 }}>
          <table>
            <thead><tr><th>Path</th><th>Value</th><th>Source</th></tr></thead>
            <tbody>
              {known.length === 0 && (
                <tr><td colSpan={3} style={{ color: 'var(--muted)' }}>
                  Nothing yet — the applicant has not answered enough of the questionnaire.
                </td></tr>
              )}
              {known.map(([path, value]) => (
                <tr key={path}>
                  <td style={{ fontFamily: 'ui-monospace, monospace', fontSize: 13 }}>{path}</td>
                  <td><strong>{value}</strong></td>
                  <td><span className="pill">Questionnaire</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <h2>Documents</h2>
        <div className="card">
          {data.documents.length === 0
            ? <p style={{ margin: 0, color: 'var(--muted)' }}>Nothing uploaded yet.</p>
            : data.documents.map((d) => (
                <div className="req" key={d.id}>
                  <div style={{ flex: 1 }}>
                    <h3>
                      <a href={`/api/documents/${d.id}`} target="_blank" rel="noreferrer">
                        {d.filename}
                      </a>
                    </h3>
                    <p>
                      {d.mimeType} · {(d.byteSize / 1024).toFixed(0)} KB · v{d.version} ·
                      sha256 {d.sha256.slice(0, 12)}…
                    </p>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <span className={`pill ${d.scanStatus === 'CLEAN' ? 'ok' : 'warn'}`}>
                      {d.scanStatus}
                    </span>
                  </div>
                </div>
              ))}
        </div>

        <h2>Recent activity</h2>
        <div className="card" style={{ padding: 0 }}>
          <table>
            <thead><tr><th>When</th><th>Action</th><th>Target</th></tr></thead>
            <tbody>
              {data.audit.map((e) => (
                <tr key={e.id}>
                  <td style={{ color: 'var(--muted)', whiteSpace: 'nowrap' }}>
                    {e.at.toISOString().replace('T', ' ').slice(0, 19)}
                  </td>
                  <td style={{ fontFamily: 'ui-monospace, monospace', fontSize: 13 }}>{e.action}</td>
                  <td style={{ color: 'var(--muted)' }}>{e.targetType}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
