'use client';

import { useActionState } from 'react';
import { uploadDocument, type UploadState } from './actions';

export function UploadControl({
  caseId, requirementId, accept,
}: { caseId: string; requirementId: string; accept: string }) {
  const bound = uploadDocument.bind(null, caseId, requirementId);
  const [state, action, pending] = useActionState<UploadState, FormData>(bound, {});

  return (
    <form action={action} style={{ marginTop: 8 }}>
      <input type="file" name="file" accept={accept} disabled={pending}
             style={{ fontSize: 14, maxWidth: 260 }} />
      <button type="submit" className="secondary" disabled={pending}
              style={{ marginLeft: 8, padding: '5px 12px', fontSize: 14 }}>
        {pending ? 'Checking…' : 'Upload'}
      </button>
      {state.error && <p className="help" style={{ color: 'var(--danger)' }}>{state.error}</p>}
      {state.ok && <p className="help" style={{ color: 'var(--ok)' }}>{state.ok}</p>}
    </form>
  );
}
