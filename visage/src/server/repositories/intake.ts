import { audit, AuditAction } from '../audit/log';
import type { AuthContext, TenantClient } from '../db/tenant';
import { isComplete, progress, validate } from '../../domain/intake/engine';
import { QUESTION_BANK, byId } from '../../domain/intake/questions';
import type { Answers, AnswerValue } from '../../domain/intake/types';
import { syncRequirements } from './checklist';

export interface IntakeState {
  readonly answers: Answers;
  readonly completedAt: Date | null;
  readonly progress: ReturnType<typeof progress>;
  readonly issues: ReturnType<typeof validate>;
}

function readAnswers(raw: unknown): Answers {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Answers) : {};
}

export async function getIntake(tx: TenantClient, caseId: string): Promise<IntakeState> {
  const row = await tx.intake.findUnique({ where: { caseId } });
  const answers = readAnswers(row?.answers);
  return {
    answers,
    completedAt: row?.completedAt ?? null,
    progress: progress(QUESTION_BANK, answers),
    issues: validate(QUESTION_BANK, answers),
  };
}

/**
 * Merge a patch of answers and re-derive the checklist.
 *
 * Saving one answer at a time is the whole interaction model — the applicant
 * may be doing this on a phone, across several sittings, and losing a page of
 * work to a dropped connection is how people abandon the process. Because the
 * checklist is re-derived on every save, answering "yes" to the arrest question
 * makes the court-records item appear immediately rather than at the end.
 *
 * Unknown question ids are rejected rather than stored: the answers blob feeds
 * the form mapping later, and letting arbitrary keys in makes it a junk drawer.
 */
export async function saveAnswers(
  tx: TenantClient,
  ctx: AuthContext,
  caseId: string,
  patch: Readonly<Record<string, AnswerValue>>,
): Promise<IntakeState> {
  const unknown = Object.keys(patch).filter((k) => !byId.has(k));
  if (unknown.length > 0) {
    throw new Error(`unknown question id(s): ${unknown.join(', ')}`);
  }

  const existing = await tx.intake.findUnique({ where: { caseId } });
  const merged: Record<string, AnswerValue> = { ...readAnswers(existing?.answers), ...patch };

  const kase = await tx.case.findUniqueOrThrow({ where: { id: caseId }, select: { firmId: true } });

  await tx.intake.upsert({
    where: { caseId },
    create: { caseId, firmId: kase.firmId, answers: merged as never },
    update: { answers: merged as never },
  });

  await syncRequirements(tx, ctx, caseId, merged);

  return {
    answers: merged,
    completedAt: existing?.completedAt ?? null,
    progress: progress(QUESTION_BANK, merged),
    issues: validate(QUESTION_BANK, merged),
  };
}

/**
 * Mark intake finished. Refuses while anything required is missing or invalid,
 * so "complete" means the same thing to the applicant and to the attorney.
 */
export async function completeIntake(
  tx: TenantClient,
  ctx: AuthContext,
  caseId: string,
): Promise<IntakeState> {
  const state = await getIntake(tx, caseId);
  if (!isComplete(QUESTION_BANK, state.answers)) {
    throw new Error('intake is not complete');
  }

  await tx.intake.update({ where: { caseId }, data: { completedAt: new Date() } });
  await tx.case.update({ where: { id: caseId }, data: { status: 'COLLECTING' } });
  await audit(tx, ctx, {
    action: 'intake.completed', targetType: 'Case', targetId: caseId, caseId,
    meta: { answered: state.progress.answered },
  });

  return { ...state, completedAt: new Date() };
}

export { AuditAction };
