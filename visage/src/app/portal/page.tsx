import Link from 'next/link';
import { redirect } from 'next/navigation';
import { currentUser } from '../../server/auth/currentUser';
import { withTenant } from '../../server/db/tenant';
import { clientCase } from '../../server/repositories/cases';
import { progress } from '../../domain/intake/engine';
import { QUESTION_BANK } from '../../domain/intake/questions';
import { logout } from '../../server/auth/actions';
import { UploadControl } from './upload';

export const dynamic = 'force-dynamic';

const STATUS_LABEL: Record<string, string> = {
  NOT_STARTED: 'Not started',
  UPLOADED: 'Waiting on your attorney',
  IN_REVIEW: 'Being reviewed',
  ACCEPTED: 'Accepted',
  REVISION_REQUESTED: 'Needs another look',
};

export default async function PortalPage() {
  const ctx = await currentUser();
  if (!ctx) redirect('/login');

  const kase = await withTenant(ctx, (tx) => clientCase(tx));
  const documents = kase
    ? await withTenant(ctx, (tx) =>
        tx.document.findMany({ where: { caseId: kase.id }, orderBy: { createdAt: 'desc' } }))
    : [];
  if (!kase) {
    return <div className="wrap"><h1>No case yet</h1>
      <p className="lede">Your attorney has not opened a case for you.</p></div>;
  }

  const answers = (kase.intake?.answers ?? {}) as Record<string, never>;
  const p = progress(QUESTION_BANK, answers);
  const done = Boolean(kase.intake?.completedAt);

  return (
    <>
      <nav className="bar">
        <strong>Visage</strong>
        <span className="spacer" />
        <form action={logout}><button className="secondary" type="submit">Sign out</button></form>
      </nav>

      <div className="wrap">
        <h1>Your green card application</h1>
        <p className="lede">Case {kase.caseNumber}</p>

        <div className="card">
          <div className="srow" style={{ marginBottom: 10 }}>
            <h3 className="name">Your questionnaire</h3>
            {done
              ? <span className="pill ok">Complete</span>
              : <span className="pill">{p.percent}% done</span>}
          </div>
          <div className="progress"><span style={{ width: `${p.percent}%` }} /></div>
          <p className="help" style={{ marginTop: 10 }}>
            {done
              ? 'Thank you. Your attorney has everything they need from the questionnaire.'
              : `${p.answered} of ${p.total} questions answered. You can stop and come back at any time.`}
          </p>
          {!done && (
            <Link href="/portal/intake">
              <button type="button" style={{ marginTop: 6 }}>
                {p.answered === 0 ? 'Start questionnaire' : 'Continue'}
              </button>
            </Link>
          )}
        </div>

        <h2>Documents to collect</h2>
        {kase.requirements.length === 0 ? (
          <div className="card">
            <p style={{ margin: 0, color: 'var(--muted)' }}>
              Your checklist appears once you begin the questionnaire — it is built from your answers,
              so you are only asked for documents that apply to you.
            </p>
          </div>
        ) : (
          <div className="card">
            {kase.requirements.map((r) => (
              <div className="req" key={r.id}>
                <div style={{ flex: 1 }}>
                  <h3>
                    {r.title}{' '}
                    {!r.required && <span className="pill">Optional</span>}
                  </h3>
                  <p>{r.rationale}</p>
                </div>
                <div style={{ textAlign: 'right', minWidth: 260 }}>
                  <span className={`pill ${r.status === 'ACCEPTED' ? 'ok' : r.status === 'REVISION_REQUESTED' ? 'warn' : ''}`}>
                    {STATUS_LABEL[r.status] ?? r.status}
                  </span>
                  {r.uploadable ? (
                    <UploadControl caseId={kase.id} requirementId={r.id}
                                   accept="application/pdf,image/*" />
                  ) : (
                    <p className="help" style={{ marginTop: 6 }}>
                      Do not upload — bring it to your attorney sealed.
                    </p>
                  )}
                  {documents.filter((d) => d.requirementId === r.id).map((d) => (
                    <p className="help" key={d.id} style={{ marginTop: 4 }}>
                      <a href={`/api/documents/${d.id}`} target="_blank" rel="noreferrer">
                        {d.filename}
                      </a>{' '}v{d.version}
                    </p>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
