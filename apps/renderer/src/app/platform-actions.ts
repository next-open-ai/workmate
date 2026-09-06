import { archivedAssetContentUrl, workspaceContentUrl } from '../services/api.js';
import { isDesktopShell } from './platform.js';

function openUrl(url: string) {
  window.open(url, '_blank', 'noopener');
}

export function copyableWorkspaceFileUrl(root: string, relative: string) {
  return workspaceContentUrl(root, relative);
}

export function copyableAssetUrl(assetId: string) {
  return archivedAssetContentUrl(assetId);
}

export async function previewWorkspaceFileUrl(root: string, relative: string) {
  if (isDesktopShell() && window.workmateDesktop) {
    const registered = await window.workmateDesktop.registerPreviewRoot(root);
    return `${registered.origin}/${relative.split('/').map(encodeURIComponent).join('/')}`;
  }
  return workspaceContentUrl(root, relative);
}

export async function previewAssetUrl(assetId: string, assetName: string) {
  if (isDesktopShell() && window.workmateDesktop) {
    const registered = await window.workmateDesktop.registerAssetPreviewRoot(assetId);
    return `${registered.origin}/${encodeURIComponent(assetName)}`;
  }
  return archivedAssetContentUrl(assetId);
}

export async function openWorkspaceFileBestEffort(root: string, relative: string) {
  if (isDesktopShell()) {
    await window.workmateDesktop?.openProjectFileInBrowser(root, relative);
    return;
  }
  openUrl(workspaceContentUrl(root, relative));
}

export async function downloadWorkspaceFileBestEffort(root: string, relative: string) {
  if (isDesktopShell()) {
    await window.workmateDesktop?.revealProjectFile(root, relative);
    return;
  }
  openUrl(workspaceContentUrl(root, relative, { download: true }));
}

export async function revealWorkspaceFileBestEffort(root: string, relative: string) {
  if (isDesktopShell()) {
    await window.workmateDesktop?.revealProjectFile(root, relative);
    return true;
  }
  return false;
}

export async function openAssetBestEffort(assetId: string) {
  if (isDesktopShell()) {
    await window.workmateDesktop?.openAssetInBrowser(assetId);
    return;
  }
  openUrl(archivedAssetContentUrl(assetId));
}

export async function downloadAssetBestEffort(assetId: string) {
  if (isDesktopShell()) {
    await window.workmateDesktop?.saveAsset(assetId);
    return;
  }
  openUrl(archivedAssetContentUrl(assetId, { download: true }));
}

export async function revealAssetBestEffort(assetId: string) {
  if (isDesktopShell()) {
    await window.workmateDesktop?.revealAsset(assetId);
    return true;
  }
  return false;
}
