import type { ReactNode } from 'react';
import './globals.css';

export const metadata = {
  title: 'Visage',
  description: 'Green card application portal',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
