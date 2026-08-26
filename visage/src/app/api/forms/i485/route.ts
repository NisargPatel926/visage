import { NextResponse } from 'next/server';
import { currentUser } from '../../../../server/auth/currentUser';
import { withTenant, isStaff } from '../../../../server/db/tenant';
import { audit, AuditAction } from '../../../../server/audit/log';
import { getIntake } from '../../../../server/repositories/intake';
import { I485_MAPPING } from '../../../../domain/forms/i485';
import { overflowFromAnswers, profileFromAnswers } from '../../../../domain/forms/profile';
import { generateForm } from '../../../../server/forms/generate';

/**
 * Generate the I-485 for a case and return it as a PDF.
 *
 * Draft only. Nothing here marks the form approved — that is the attorney's
 * explicit action, and it is the gate the whole product is built around.
 */
export async function GET(req: Request) {
  const ctx = await currentUser();
  if (!ctx) return new NextResponse('Unauthorized', { status: 401 });

  const caseId = new URL(req.url).searchParams.get('case');
  if (!caseId) return new NextResponse('Missing case', { status: 400 });

  const result = await withTenant(ctx, async (tx) => {
    const kase = await tx.case.findUnique({ where: { id: caseId } });
    if (!kase) return null;

    const intake = await getIntake(tx, caseId);
    const generated = await generateForm(
      I485_MAPPING,
      profileFromAnswers(intake.answers),
      overflowFromAnswers(intake.answers),
    );

    await audit(tx, ctx, {
      action: AuditAction.FORM_GENERATED, targetType: 'FormInstance', targetId: caseId,
      caseId,
      meta: {
        formCode: I485_MAPPING.formCode, edition: I485_MAPPING.edition,
        filled: generated.filled, overflowUsed: generated.overflowUsed,
        overflowDropped: generated.overflowDropped,
      },
    });

    return { generated, caseNumber: kase.caseNumber };
  });

  if (!result) return new NextResponse('Not found', { status: 404 });

  const disposition = isStaff(ctx) ? 'inline' : 'attachment';
  return new NextResponse(new Uint8Array(result.generated.bytes), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `${disposition}; filename="I-485-${result.caseNumber}-DRAFT.pdf"`,
      'Cache-Control': 'private, no-store',
      'X-Visage-Fields-Filled': String(result.generated.filled),
      'X-Visage-Overflow-Dropped': String(result.generated.overflowDropped),
    },
  });
}
