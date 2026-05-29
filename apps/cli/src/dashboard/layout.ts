/** Rect in 0-based screen coordinates (top-left origin). */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DashboardLayout {
  cols: number;
  rows: number;
  sidebar: Rect;
  /** Single column separator between sidebar and right pane. */
  sepX: number;
  right: Rect;
  /** Full-width status line, single row at the bottom. */
  statusY: number;
  /** Effective height of the 3-line alert band above the footer (0 when no
   *  alert is active, or when the terminal is too small to host it). */
  alertH: number;
  /** Top row of the alert band (0-based). Equals `statusY` when alertH === 0. */
  alertY: number;
  /** Right pane too small to host a usable terminal. */
  tooSmall: boolean;
}

export const SIDEBAR_WIDTH = 33;
const MIN_RIGHT_W = 20;
const MIN_RIGHT_H = 4;

/**
 * Compute the screen layout. `requestedAlertH` is the desired band height
 * (3 when the selected box has an active alert; 0 otherwise); the band is
 * silently dropped to 0 if reserving it would push the right pane below
 * `MIN_RIGHT_H`, keeping the inner PTY usable on tiny terminals.
 */
export function computeLayout(
  cols: number,
  rows: number,
  requestedAlertH = 0,
): DashboardLayout {
  const sidebarW = Math.min(SIDEBAR_WIDTH, Math.max(0, cols - MIN_RIGHT_W - 1));
  const sepX = sidebarW;
  const rightX = sidebarW + 1;
  const rightW = Math.max(0, cols - rightX);
  const statusY = rows - 1;
  const desired = Math.max(0, requestedAlertH);
  // Drop the band if it would starve the right pane; the compositor falls
  // back to today's footer-replacement on this path so the alert isn't lost.
  const alertH = statusY - desired >= MIN_RIGHT_H ? desired : 0;
  const paneH = Math.max(0, statusY - alertH);
  const alertY = statusY - alertH;
  return {
    cols,
    rows,
    sidebar: { x: 0, y: 0, w: sidebarW, h: paneH },
    sepX,
    right: { x: rightX, y: 0, w: rightW, h: paneH },
    statusY,
    alertH,
    alertY,
    tooSmall: rightW < MIN_RIGHT_W || paneH < MIN_RIGHT_H,
  };
}
