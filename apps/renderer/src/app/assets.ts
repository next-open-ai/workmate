import { ref } from 'vue';
import { archiveWorkspaceArtifact, linkArchivedAssets, listArchivedAssets, unlinkArchivedAssets } from '../services/api.js';

export interface Asset {
  id: string;
  name: string;
  relativePath: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: number;
  orgId?: string | null;
  ownerUserId?: string | null;
  userId?: string | null;
  accessScope?: 'private' | 'org-shared' | 'delegated';
  accessGrants?: Array<{
    subjectType: 'user';
    subjectId: string;
    permissions: Array<'read' | 'write'>;
    createdAt: number;
    expiresAt?: number;
  }>;
  conversationId: string | null;
  employeeId: string | null;
  runId: string;
  sha256: string;
  projectId: string | null;
  workspaceRelative: string | null;
}

const assets = ref<Asset[]>([]);
const loading = ref(false);

export function useAssets() {
  const loadAssets = async () => {
    loading.value = true;
    try {
      assets.value = (await listArchivedAssets()).map((asset) => ({
        ...asset,
        projectId: asset.projectId ?? null,
        workspaceRelative: asset.workspaceRelative ?? asset.name ?? null,
      })) as Asset[];
    } finally {
      loading.value = false;
    }
  };
  const archiveArtifact = async (input: {
    runId: string;
    relativePath: string;
    conversationId?: string;
    employeeId?: string;
    projectId?: string;
  }) => {
    const asset = (await archiveWorkspaceArtifact(input)) as Asset;
    if (!assets.value.some((item) => item.id === asset.id)) assets.value = [asset, ...assets.value];
    return asset;
  };
  const linkAssetsToProject = async (input: { projectId: string; assetIds: string[]; workspacePath?: string }) => {
    const result = await linkArchivedAssets(input);
    await loadAssets();
    return result;
  };
  const unlinkAssetsFromProject = async (assetIds: string[]) => {
    const result = await unlinkArchivedAssets(assetIds);
    await loadAssets();
    return result;
  };
  return { assets, loading, loadAssets, archiveArtifact, linkAssetsToProject, unlinkAssetsFromProject };
}
