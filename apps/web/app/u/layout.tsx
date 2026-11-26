import '@agentbox/usage-view/usage.css';
import type { ReactNode } from 'react';

export default function ShareLayout({ children }: { children: ReactNode }) {
  return <main className="flex-1 bg-fd-background">{children}</main>;
}
