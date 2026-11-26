'use client';

// Sidebar collapse state. It lives on <html> as `.sb-collapsed` (the layout's
// pre-paint script restores it from `hub-sidebar`) so CSS alone sizes the rail;
// React reads the class back through this hook.

import { useSyncExternalStore } from 'react';

const KEY = 'hub-sidebar';
const EVENT = 'hub-sidebar-change';
const DRAWER = '(max-width: 767.98px)';

export function toggleSidebar(): void {
  const collapsed = document.documentElement.classList.toggle('sb-collapsed');
  try {
    localStorage.setItem(KEY, collapsed ? 'collapsed' : 'open');
  } catch {
    // storage blocked: the toggle still works for this page view
  }
  window.dispatchEvent(new Event(EVENT));
}

/** The header button: a drawer under Tailwind's md (768px), the rail toggle above. */
export function toggleNav(): void {
  if (window.matchMedia(DRAWER).matches) {
    document.body.classList.toggle('nav-open');
  } else {
    toggleSidebar();
  }
}

function subscribe(cb: () => void): () => void {
  const mq = window.matchMedia(DRAWER);
  window.addEventListener(EVENT, cb);
  mq.addEventListener('change', cb);
  return () => {
    window.removeEventListener(EVENT, cb);
    mq.removeEventListener('change', cb);
  };
}

/** Whether the sidebar is the icon rail; the phone drawer is always full width. */
export function useSidebarCollapsed(): boolean {
  return useSyncExternalStore(
    subscribe,
    () =>
      document.documentElement.classList.contains('sb-collapsed') &&
      !window.matchMedia(DRAWER).matches,
    () => false,
  );
}
