import type { AuthContext, TenantClient } from '../db/tenant';

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
  // A bare INSERT, not prisma.auditEvent.create().
  //
  // Prisma's create() appends RETURNING, and PostgreSQL applies the SELECT
  // policy to any INSERT that returns columns. Clients can append to the audit
  // log but deliberately cannot read it, so create() fails for exactly the
  // actors whose actions most need recording. Nothing here needs the row back.
  await tx.$executeRaw`
    insert into "AuditEvent" (
      id, "firmId", "actorId", "caseId", action, "targetType", "targetId",
      ip, "userAgent", meta, at
    ) values (
      gen_random_uuid(),
      ${ctx.firmId}::uuid,
      ${ctx.userId}::uuid,
      ${input.caseId ?? null}::uuid,
      ${input.action},
      ${input.targetType},
      ${input.targetId},
      ${input.ip ?? null},
      ${input.userAgent ?? null},
      ${JSON.stringify(input.meta ?? null)}::jsonb,
      now()
    )
  `;
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
