import { redirect } from 'next/navigation';
import { currentUser } from '../../server/auth/currentUser';
import { withTenant, isStaff } from '../../server/db/tenant';
import { caseQueue } from '../../server/repositories/cases';
import { logout } from '../../server/auth/actions';

export const dynamic = 'force-dynamic';

export default async function ConsolePage() {
  const ctx = await currentUser();
  if (!ctx) redirect('/login');
  // A client reaching this URL sees their own portal, not an empty console.
  if (!isStaff(ctx)) redirect('/portal');

  const queue = await withTenant(ctx, (tx) => caseQueue(tx));
  const attention = queue.filter((q) => q.needsAttention).length;

  return (
    <>
      <nav className="bar">
        <strong>Visage</strong>
        <span style={{ color: 'var(--muted)' }}>Console</span>
        <span className="spacer" />
        <form action={logout}><button className="secondary" type="submit">Sign out</button></form>
      </nav>

      <div className="wrap">
        <h1>Cases</h1>
        <p className="lede">
          {attention > 0
            ? `${attention} case${attention === 1 ? '' : 's'} waiting on you.`
            : 'Nothing is waiting on you right now.'}
        </p>

        <div className="card" style={{ padding: 0 }}>
          <table>
            <thead>
              <tr>
                <th>Case</th><th>Applicant</th><th>Status</th>
                <th>Intake</th><th>Outstanding</th><th>To review</th>
              </tr>
            </thead>
            <tbody>
              {queue.length === 0 && (
                <tr><td colSpan={6} style={{ color: 'var(--muted)' }}>No cases yet.</td></tr>
              )}
              {queue.map((c) => (
                <tr key={c.id}>
                  <td><strong>{c.caseNumber}</strong></td>
                  <td>{c.applicantName}</td>
                  <td><span className="pill">{c.status}</span></td>
                  <td>{c.intakePercent}%</td>
                  <td>{c.outstanding}</td>
                  <td>
                    {c.awaitingReview > 0
                      ? <span className="pill warn">{c.awaitingReview} waiting</span>
                      : <span style={{ color: 'var(--muted)' }}>—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
