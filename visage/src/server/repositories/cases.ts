import type { TenantClient } from '../db/tenant';

export interface QueueItem {
  readonly id: string;
  readonly caseNumber: string;
  readonly status: string;
  readonly applicantName: string;
  readonly intakePercent: number;
  readonly outstanding: number;
  readonly awaitingReview: number;
  readonly needsAttention: boolean;
  readonly updatedAt: Date;
}

/**
 * The staff case queue.
 *
 * Sorted by what needs a human rather than by recency: a case with documents
 * waiting on review outranks one that was merely touched most recently. An
 * inbox that sorts by time makes the attorney do the triage the software
 * should have done.
 */
export async function caseQueue(tx: TenantClient): Promise<QueueItem[]> {
  const cases = await tx.case.findMany({
    include: {
      intake: { select: { answers: true, completedAt: true } },
      requirements: { where: { status: { not: 'WITHDRAWN' } }, select: { status: true } },
      members: { include: { user: { select: { email: true } } } },
    },
  });

  const { progress } = await import('../../domain/intake/engine');
  const { QUESTION_BANK } = await import('../../domain/intake/questions');

  const items = cases.map((c): QueueItem => {
    const answers = (c.intake?.answers ?? {}) as Record<string, never>;
    const p = progress(QUESTION_BANK, answers);
    const outstanding = c.requirements.filter(
      (r) => r.status === 'NOT_STARTED' || r.status === 'REVISION_REQUESTED',
    ).length;
    const awaitingReview = c.requirements.filter(
      (r) => r.status === 'UPLOADED' || r.status === 'IN_REVIEW',
    ).length;
    const applicant = c.members.find((m) => m.role === 'PRIMARY_APPLICANT');

    return {
      id: c.id,
      caseNumber: c.caseNumber,
      status: c.status,
      applicantName: applicant?.user.email ?? '—',
      intakePercent: p.percent,
      outstanding,
      awaitingReview,
      needsAttention: awaitingReview > 0,
      updatedAt: c.updatedAt,
    };
  });

  return items.sort((a, b) => {
    if (a.needsAttention !== b.needsAttention) return a.needsAttention ? -1 : 1;
    if (a.awaitingReview !== b.awaitingReview) return b.awaitingReview - a.awaitingReview;
    return b.updatedAt.getTime() - a.updatedAt.getTime();
  });
}

/** The single case a client sees on their dashboard. */
export async function clientCase(tx: TenantClient) {
  return tx.case.findFirst({
    include: {
      intake: { select: { answers: true, completedAt: true } },
      requirements: {
        where: { status: { not: 'WITHDRAWN' } },
        orderBy: [{ required: 'desc' }, { key: 'asc' }],
      },
    },
  });
}
