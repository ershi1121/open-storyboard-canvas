import { describe, expect, it, vi } from 'vitest';
import {
  WEB_PROJECT_STATE_STORAGE_KEY,
  createWebProjectStateAdapter,
  type ProjectRecord,
  type WebProjectStorage,
} from './webProjectState';

class FakeStorage implements WebProjectStorage {
  private readonly values = new Map<string, string>();
  failReads = false;
  failWrites = false;

  getItem(key: string): string | null {
    if (this.failReads) {
      throw new Error('storage read blocked');
    }
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.failWrites) {
      throw new Error('quota exceeded');
    }
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

function createRecord(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: 'project-1',
    name: 'Web project',
    createdAt: 100,
    updatedAt: 200,
    nodeCount: 1,
    nodesJson: '[{"id":"node-1"}]',
    edgesJson: '[]',
    viewportJson: '{"x":12,"y":24,"zoom":1.2}',
    historyJson: '{"past":[],"future":[],"imagePool":[]}',
    imagePoolJson: '[]',
    ...overrides,
  };
}

describe('web project state adapter', () => {
  it('persists a versioned project record and restores canvas data after reload', async () => {
    const storage = new FakeStorage();
    const adapter = createWebProjectStateAdapter({ storage });
    const record = createRecord();

    await adapter.upsertProjectRecord(record);

    const stored = JSON.parse(storage.getItem(WEB_PROJECT_STATE_STORAGE_KEY) ?? '{}') as {
      version?: number;
      projects?: ProjectRecord[];
    };
    expect(stored.version).toBe(1);
    expect(stored.projects).toEqual([record]);

    const reloaded = createWebProjectStateAdapter({ storage });
    expect(await reloaded.getProjectRecord(record.id)).toEqual(record);
    expect(await reloaded.listProjectSummaries()).toEqual([
      {
        id: record.id,
        name: record.name,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        nodeCount: record.nodeCount,
      },
    ]);
  });

  it('mirrors the existing project CRUD and viewport command behavior', async () => {
    const storage = new FakeStorage();
    const adapter = createWebProjectStateAdapter({ storage });
    const record = createRecord();

    await adapter.upsertProjectRecord(record);
    await adapter.renameProjectRecord(record.id, 'Renamed', 300);
    await adapter.updateProjectViewportRecord(record.id, '{"x":1,"y":2,"zoom":0.8}');

    expect(await adapter.getProjectRecord(record.id)).toMatchObject({
      name: 'Renamed',
      updatedAt: 300,
      viewportJson: '{"x":1,"y":2,"zoom":0.8}',
    });

    await adapter.deleteProjectRecord(record.id);
    expect(await adapter.getProjectRecord(record.id)).toBeNull();
    expect(await adapter.listProjectSummaries()).toEqual([]);
  });

  it('falls back to session memory once when browser storage is unavailable', async () => {
    const onStatusChange = vi.fn();
    const adapter = createWebProjectStateAdapter({ storage: null, onStatusChange });
    const record = createRecord();

    expect(await adapter.listProjectSummaries()).toEqual([]);
    await adapter.upsertProjectRecord(record);

    expect(await adapter.getProjectRecord(record.id)).toEqual(record);
    expect(adapter.getStorageStatus()).toEqual({
      mode: 'memory',
      reason: 'unavailable',
    });
    expect(onStatusChange).toHaveBeenCalledTimes(1);
  });

  it('keeps the latest project in memory when a persistent write fails', async () => {
    const storage = new FakeStorage();
    const onStatusChange = vi.fn();
    const adapter = createWebProjectStateAdapter({ storage, onStatusChange });
    await adapter.listProjectSummaries();
    storage.failWrites = true;

    const record = createRecord();
    await adapter.upsertProjectRecord(record);

    expect(await adapter.getProjectRecord(record.id)).toEqual(record);
    expect(adapter.getStorageStatus()).toEqual({
      mode: 'memory',
      reason: 'write-failed',
    });
    expect(onStatusChange).toHaveBeenCalledTimes(1);
  });

  it('does not overwrite an unsupported storage version', async () => {
    const storage = new FakeStorage();
    storage.setItem(WEB_PROJECT_STATE_STORAGE_KEY, JSON.stringify({
      version: 99,
      projects: [createRecord()],
    }));
    const adapter = createWebProjectStateAdapter({ storage });

    expect(await adapter.listProjectSummaries()).toEqual([]);
    expect(adapter.getStorageStatus()).toEqual({
      mode: 'memory',
      reason: 'unsupported-version',
    });
    expect(JSON.parse(storage.getItem(WEB_PROJECT_STATE_STORAGE_KEY) ?? '{}')).toMatchObject({
      version: 99,
    });
  });
});
