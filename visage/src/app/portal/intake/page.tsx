import Link from 'next/link';
import { redirect } from 'next/navigation';
import { currentUser } from '../../../server/auth/currentUser';
import { withTenant } from '../../../server/db/tenant';
import { clientCase } from '../../../server/repositories/cases';
import { getIntake } from '../../../server/repositories/intake';
import { visibleQuestions, isAnswered } from '../../../domain/intake/engine';
import { QUESTION_BANK } from '../../../domain/intake/questions';
import { SECTIONS, type Question, type SectionId } from '../../../domain/intake/types';
import { finishIntake, saveSection } from '../actions';

export const dynamic = 'force-dynamic';

function Field({ q, value }: { q: Question; value: unknown }) {
  const id = q.id;
  return (
    <div className="field">
      <label htmlFor={id}>
        {q.prompt}
        {!q.required && <span className="pill" style={{ marginLeft: 8 }}>Optional</span>}
      </label>
      {q.help && <p className="help">{q.help}</p>}

      {q.kind === 'boolean' && (
        <>
          <label className="choice">
            <input type="radio" name={id} value="yes" defaultChecked={value === true} /> Yes
          </label>
          <label className="choice">
            <input type="radio" name={id} value="no" defaultChecked={value === false} /> No
          </label>
        </>
      )}

      {q.kind === 'select' && (
        <select id={id} name={id} defaultValue={typeof value === 'string' ? value : ''}>
          <option value="">Choose…</option>
          {q.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      )}

      {q.kind === 'multiselect' && q.options?.map((o) => (
        <label className="choice" key={o.value}>
          <input type="checkbox" name={id} value={o.value}
                 defaultChecked={Array.isArray(value) && value.includes(o.value)} />
          {o.label}
        </label>
      ))}

      {q.kind === 'longtext' && (
        <textarea id={id} name={id} defaultValue={typeof value === 'string' ? value : ''} />
      )}

      {(q.kind === 'text' || q.kind === 'date' || q.kind === 'number') && (
        <input id={id} name={id}
               type={q.kind === 'date' ? 'date' : q.kind === 'number' ? 'number' : 'text'}
               defaultValue={value == null ? '' : String(value)} />
      )}
    </div>
  );
}

export default async function IntakePage({
  searchParams,
}: { searchParams: Promise<{ section?: string }> }) {
  const ctx = await currentUser();
  if (!ctx) redirect('/login');

  const kase = await withTenant(ctx, (tx) => clientCase(tx));
  if (!kase) redirect('/portal');

  const state = await withTenant(ctx, (tx) => getIntake(tx, kase.id));
  const params = await searchParams;

  const visible = visibleQuestions(QUESTION_BANK, state.answers);
  const sectionId = (params.section ?? SECTIONS[0].id) as SectionId;
  const section = SECTIONS.find((s) => s.id === sectionId) ?? SECTIONS[0];
  const questions = visible.filter((q) => q.section === section.id);
  const ids = questions.map((q) => q.id);

  const save = saveSection.bind(null, kase.id, ids);
  const finish = finishIntake.bind(null, kase.id);

  const idx = SECTIONS.findIndex((s) => s.id === section.id);
  const next = SECTIONS[idx + 1];
  const allAnswered = visible.every((q) => isAnswered(state.answers[q.id]));

  return (
    <>
      <nav className="bar">
        <strong>Visage</strong>
        <span className="spacer" />
        <Link href="/portal">Back to overview</Link>
      </nav>

      <div className="wrap">
        <h1>{section.title}</h1>
        <p className="lede">{section.blurb}</p>

        <div className="card sections">
          {state.progress.bySection.map((s) => (
            <div className="srow" key={s.section}>
              <span className="name">
                {s.section === section.id ? <strong>{s.title}</strong>
                  : <Link href={`/portal/intake?section=${s.section}`}>{s.title}</Link>}
              </span>
              <span className="pill" style={{
                background: s.complete ? 'var(--ok-soft)' : undefined,
                color: s.complete ? 'var(--ok)' : undefined,
              }}>
                {s.answered}/{s.total}
              </span>
            </div>
          ))}
        </div>

        <form action={save} className="card">
          {questions.map((q) => <Field key={q.id} q={q} value={state.answers[q.id]} />)}
          <button type="submit">Save and continue</button>
          {next && (
            <Link href={`/portal/intake?section=${next.id}`} style={{ marginLeft: 14 }}>
              Skip to {next.title}
            </Link>
          )}
        </form>

        {allAnswered && state.issues.length === 0 && !state.completedAt && (
          <form action={finish} className="card">
            <h3>Everything is answered</h3>
            <p className="help">
              Your attorney reviews every answer. You can still change them afterwards by asking them.
            </p>
            <button type="submit">Submit questionnaire</button>
          </form>
        )}
      </div>
    </>
  );
}
