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
