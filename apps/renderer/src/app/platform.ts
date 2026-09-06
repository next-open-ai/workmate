import type { View } from './workspace.js';

export function isDesktopShell(): boolean {
  return Boolean(window.workmateDesktop);
}

export function isWebRuntime(): boolean {
  return !isDesktopShell();
}

const desktopOnlyViews = new Set<View>([]);

export function isViewAvailable(view: View): boolean {
  return !desktopOnlyViews.has(view) || isDesktopShell();
}
