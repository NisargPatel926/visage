import { redirect } from 'next/navigation';
import { currentUser } from '../server/auth/currentUser';

export default async function Home() {
  const ctx = await currentUser();
  if (!ctx) redirect('/login');
  redirect(ctx.role === 'CLIENT' ? '/portal' : '/console');
}
