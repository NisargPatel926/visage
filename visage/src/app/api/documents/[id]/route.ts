import { NextResponse } from 'next/server';
import { currentUser } from '../../../../server/auth/currentUser';
import { withTenant } from '../../../../server/db/tenant';
import { readDocument } from '../../../../server/documents/ingest';

/**
 * Serve a stored document.
 *
 * Never a bucket URL: every read goes through here so it can be authorised,
 * audited, and decrypted. Authorisation is RLS — readDocument runs inside
 * withTenant, so a document belonging to another case simply is not found.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await currentUser();
  if (!ctx) return new NextResponse('Unauthorized', { status: 401 });

  const { id } = await params;
  const doc = await withTenant(ctx, (tx) => readDocument(tx, ctx, id));
  // 404 rather than 403 for a document in another tenant: distinguishing them
  // confirms the id exists.
  if (!doc) return new NextResponse('Not found', { status: 404 });

  return new NextResponse(new Uint8Array(doc.bytes), {
    headers: {
      'Content-Type': doc.mimeType,
      'Content-Disposition': `inline; filename="${doc.filename.replace(/"/g, '')}"`,
      'Cache-Control': 'private, no-store',
      'Content-Security-Policy': "default-src 'none'; object-src 'none'",
    },
  });
}
