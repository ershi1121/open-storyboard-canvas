import { invoke, isTauri } from '@tauri-apps/api/core';
import {
  deleteWebProjectRecord,
  getWebProjectRecord,
  listWebProjectSummaries,
  renameWebProjectRecord,
  updateWebProjectViewportRecord,
  upsertWebProjectRecord,
  type ProjectRecord,
  type ProjectSummaryRecord,
} from './webProjectState';

export {
  subscribeWebProjectStorageStatus,
  type WebProjectStorageStatus,
} from './webProjectState';
export type { ProjectRecord, ProjectSummaryRecord } from './webProjectState';

export async function listProjectSummaries(): Promise<ProjectSummaryRecord[]> {
  if (!isTauri()) {
    return await listWebProjectSummaries();
  }
  return await invoke<ProjectSummaryRecord[]>('list_project_summaries');
}

export async function getProjectRecord(projectId: string): Promise<ProjectRecord | null> {
  if (!isTauri()) {
    return await getWebProjectRecord(projectId);
  }
  return await invoke<ProjectRecord | null>('get_project_record', { projectId });
}

export async function upsertProjectRecord(record: ProjectRecord): Promise<void> {
  if (!isTauri()) {
    await upsertWebProjectRecord(record);
    return;
  }
  await invoke('upsert_project_record', { record });
}

export async function updateProjectViewportRecord(
  projectId: string,
  viewportJson: string
): Promise<void> {
  if (!isTauri()) {
    await updateWebProjectViewportRecord(projectId, viewportJson);
    return;
  }
  await invoke('update_project_viewport_record', { projectId, viewportJson });
}

export async function renameProjectRecord(
  projectId: string,
  name: string,
  updatedAt: number
): Promise<void> {
  if (!isTauri()) {
    await renameWebProjectRecord(projectId, name, updatedAt);
    return;
  }
  await invoke('rename_project_record', { projectId, name, updatedAt });
}

export async function deleteProjectRecord(projectId: string): Promise<void> {
  if (!isTauri()) {
    await deleteWebProjectRecord(projectId);
    return;
  }
  await invoke('delete_project_record', { projectId });
}
