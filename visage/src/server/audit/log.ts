import type { AuthContext, TenantClient } from '../db/tenant.js';

/**
 * Append-only record of who touched what.
 *
 * Enforcement is in the database: `visage_app` holds INSERT and SELECT on
 * AuditEvent but not UPDATE or DELETE, so "append-only" survives a bug in this
 * file. Serving compliance, malpractice defence, and incident response at once.
 */
export interface AuditInput {
  action: string;
  targetType: string;
  targetId: string;
  caseId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  meta?: Record<string, unknown> | null;
}

/**
 * Written inside the caller's transaction on purpose: if the action rolls back,
 * so does its audit row, and the log never claims something happened that
 * didn't.
 */
export async function audit(
  tx: TenantClient,
  ctx: AuthContext,
  input: AuditInput,
): Promise<void> {
  await tx.auditEvent.create({
    data: {
      firmId: ctx.firmId,
      actorId: ctx.userId,
      caseId: input.caseId ?? null,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
      meta: (input.meta ?? undefined) as never,
    },
  });
}

/** Actions worth a row. Named constants keep the log queryable. */
export const AuditAction = {
  LOGIN_SUCCEEDED: 'auth.login.succeeded',
  LOGIN_FAILED: 'auth.login.failed',
  MFA_ENROLLED: 'auth.mfa.enrolled',
  SESSION_REVOKED: 'auth.session.revoked',
  CASE_CREATED: 'case.created',
  CASE_VIEWED: 'case.viewed',
  DOCUMENT_UPLOADED: 'document.uploaded',
  DOCUMENT_DOWNLOADED: 'document.downloaded',
  PROFILE_OVERRIDDEN: 'profile.overridden',
  FORM_GENERATED: 'form.generated',
  FORM_APPROVED: 'form.approved',
  PACKAGE_GENERATED: 'package.generated',
} as const;
