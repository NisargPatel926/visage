'use server';

import { revalidatePath } from 'next/cache';
import { currentUser } from '../../server/auth/currentUser';
import { withTenant } from '../../server/db/tenant';
import { completeIntake, saveAnswers } from '../../server/repositories/intake';
import { byId } from '../../domain/intake/questions';
import type { AnswerValue } from '../../domain/intake/types';

/** Coerce a form value into the shape its question expects. */
function coerce(questionId: string, form: FormData): AnswerValue {
  const q = byId.get(questionId);
  if (!q) throw new Error(`unknown question: ${questionId}`);

  if (q.kind === 'multiselect') return form.getAll(questionId).map(String);
  const raw = form.get(questionId);
  if (raw === null) return q.kind === 'boolean' ? null : null;

  const s = String(raw);
  if (q.kind === 'boolean') return s === '' ? null : s === 'yes';
  if (q.kind === 'number') return s === '' ? null : Number(s);
  return s;
}

export async function saveSection(caseId: string, questionIds: string[], form: FormData) {
  const ctx = await currentUser();
  if (!ctx) throw new Error('not signed in');

  const patch: Record<string, AnswerValue> = {};
  for (const id of questionIds) patch[id] = coerce(id, form);

  // The case id arrives from the page, but it is never trusted: withTenant
  // scopes the write, so a tampered id simply matches no rows.
  await withTenant(ctx, (tx) => saveAnswers(tx, ctx, caseId, patch));
  revalidatePath('/portal');
  revalidatePath('/portal/intake');
}

export async function finishIntake(caseId: string) {
  const ctx = await currentUser();
  if (!ctx) throw new Error('not signed in');
  await withTenant(ctx, (tx) => completeIntake(tx, ctx, caseId));
  revalidatePath('/portal');
}

export interface UploadState { error?: string; ok?: string }

/** Upload a document against a checklist item. */
export async function uploadDocument(
  caseId: string,
  requirementId: string,
  _prev: UploadState,
  form: FormData,
): Promise<UploadState> {
  const ctx = await currentUser();
  if (!ctx) return { error: 'Your session has expired. Please sign in again.' };

  const file = form.get('file');
  if (!(file instanceof File) || file.size === 0) return { error: 'Choose a file first.' };

  const { ingestDocument, UploadRejected } = await import('../../server/documents/ingest');
  const bytes = Buffer.from(await file.arrayBuffer());

  try {
    await withTenant(ctx, (tx) =>
      ingestDocument(tx, ctx, {
        caseId, requirementId, filename: file.name,
        declaredMime: file.type, bytes,
      }),
    );
  } catch (err) {
    // A rejection carries a message written for the applicant; anything else
    // must not leak internals to them.
    if (err instanceof UploadRejected) return { error: err.message };
    console.error('upload failed', err);
    return { error: 'Something went wrong storing that file. Please try again.' };
  }

  revalidatePath('/portal');
  return { ok: `${file.name} uploaded.` };
}
