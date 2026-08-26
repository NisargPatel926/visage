import { audit } from '../audit/log';
import type { AuthContext, TenantClient } from '../db/tenant';
import { deriveRequirements } from '../../domain/checklist/engine';
import type { Answers } from '../../domain/intake/types';

export interface SyncSummary {
  readonly added: string[];
  readonly withdrawn: string[];
  readonly reinstated: string[];
}

/**
 * Reconcile the stored checklist with what the answers now imply.
 *
 * Requirements are never deleted. If an answer changes so that an item no
 * longer applies it is marked WITHDRAWN, because the applicant may already have
 * uploaded a document against it and making that vanish — along with any
 * attorney comments on it — is both alarming and destructive. Withdrawn items
 * come back as NOT_STARTED if they become relevant again, so flip-flopping on
 * a question does not orphan work.
 *
 * A requirement the attorney has already ACCEPTED is left alone entirely: their
 * judgment outranks a rule re-run.
 */
export async function syncRequirements(
  tx: TenantClient,
  ctx: AuthContext,
  caseId: string,
  answers: Answers,
): Promise<SyncSummary> {
  const derived = deriveRequirements(answers);
  const derivedByKey = new Map(derived.map((d) => [d.key, d]));

  const kase = await tx.case.findUniqueOrThrow({ where: { id: caseId }, select: { firmId: true } });
  const existing = await tx.requirement.findMany({ where: { caseId } });
  const existingByKey = new Map(existing.map((r) => [r.key, r]));

  const added: string[] = [];
  const withdrawn: string[] = [];
  const reinstated: string[] = [];

  for (const d of derived) {
    const current = existingByKey.get(d.key);
    if (!current) {
      await tx.requirement.create({
        data: {
          caseId, firmId: kase.firmId, key: d.key, title: d.title, rationale: d.rationale,
          required: d.required, acceptedDocTypes: d.acceptedDocTypes, uploadable: d.uploadable,
        },
      });
      added.push(d.key);
      continue;
    }
    // Keep copy and metadata current, but never overwrite workflow status.
    await tx.requirement.update({
      where: { id: current.id },
      data: {
        title: d.title, rationale: d.rationale, required: d.required,
        acceptedDocTypes: d.acceptedDocTypes, uploadable: d.uploadable,
        ...(current.status === 'WITHDRAWN' ? { status: 'NOT_STARTED' as const } : {}),
      },
    });
    if (current.status === 'WITHDRAWN') reinstated.push(d.key);
  }

  for (const r of existing) {
    if (derivedByKey.has(r.key)) continue;
    if (r.status === 'WITHDRAWN' || r.status === 'ACCEPTED') continue;
    await tx.requirement.update({ where: { id: r.id }, data: { status: 'WITHDRAWN' } });
    withdrawn.push(r.key);
  }

  if (added.length || withdrawn.length || reinstated.length) {
    await audit(tx, ctx, {
      action: 'checklist.synced', targetType: 'Case', targetId: caseId, caseId,
      meta: { added, withdrawn, reinstated },
    });
  }

  return { added, withdrawn, reinstated };
}

export async function getChecklist(tx: TenantClient, caseId: string) {
  return tx.requirement.findMany({
    where: { caseId, status: { not: 'WITHDRAWN' } },
    orderBy: [{ required: 'desc' }, { key: 'asc' }],
  });
}
