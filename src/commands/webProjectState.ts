export interface ProjectSummaryRecord {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  nodeCount: number;
}

export interface ProjectRecord extends ProjectSummaryRecord {
  nodesJson: string;
  edgesJson: string;
  viewportJson: string;
  historyJson: string;
  imagePoolJson?: string | null;
  imagePool?: string[] | null;
}

export interface WebProjectStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export type WebProjectStorageFallbackReason =
  | 'unavailable'
  | 'read-failed'
  | 'write-failed'
  | 'invalid-data'
  | 'unsupported-version';

export type WebProjectStorageStatus =
  | { mode: 'pending' }
  | { mode: 'persistent' }
  | { mode: 'memory'; reason: WebProjectStorageFallbackReason };

export interface WebProjectStateAdapter {
  listProjectSummaries: () => Promise<ProjectSummaryRecord[]>;
  getProjectRecord: (projectId: string) => Promise<ProjectRecord | null>;
  upsertProjectRecord: (record: ProjectRecord) => Promise<void>;
  updateProjectViewportRecord: (projectId: string, viewportJson: string) => Promise<void>;
  renameProjectRecord: (projectId: string, name: string, updatedAt: number) => Promise<void>;
  deleteProjectRecord: (projectId: string) => Promise<void>;
  getStorageStatus: () => WebProjectStorageStatus;
}

interface PersistedWebProjectStateV1 {
  version: 1;
  projects: ProjectRecord[];
}

interface CreateWebProjectStateAdapterOptions {
  storage?: WebProjectStorage | null | (() => WebProjectStorage | null);
  storageKey?: string;
  onStatusChange?: (status: WebProjectStorageStatus) => void;
}

export const WEB_PROJECT_STATE_STORAGE_KEY = 'storyboard-copilot:web-project-state';
const WEB_PROJECT_STATE_VERSION = 1;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNullableString(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || typeof value === 'string';
}

function isNullableStringArray(value: unknown): value is string[] | null | undefined {
  return value === undefined
    || value === null
    || (Array.isArray(value) && value.every((item) => typeof item === 'string'));
}

function isProjectRecord(value: unknown): value is ProjectRecord {
  if (!isPlainRecord(value)) {
    return false;
  }

  return (
    typeof value.id === 'string'
    && typeof value.name === 'string'
    && isFiniteNumber(value.createdAt)
    && isFiniteNumber(value.updatedAt)
    && isFiniteNumber(value.nodeCount)
    && typeof value.nodesJson === 'string'
    && typeof value.edgesJson === 'string'
    && typeof value.viewportJson === 'string'
    && typeof value.historyJson === 'string'
    && isNullableString(value.imagePoolJson)
    && isNullableStringArray(value.imagePool)
  );
}

function cloneProjectRecord(record: ProjectRecord): ProjectRecord {
  return {
    ...record,
    imagePool: Array.isArray(record.imagePool) ? [...record.imagePool] : record.imagePool,
  };
}

function toProjectSummary(record: ProjectRecord): ProjectSummaryRecord {
  return {
    id: record.id,
    name: record.name,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    nodeCount: record.nodeCount,
  };
}

function parsePersistedState(raw: string):
  | { ok: true; records: ProjectRecord[] }
  | { ok: false; reason: 'invalid-data' | 'unsupported-version' } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'invalid-data' };
  }

  if (!isPlainRecord(parsed)) {
    return { ok: false, reason: 'invalid-data' };
  }
  if (parsed.version !== WEB_PROJECT_STATE_VERSION) {
    return { ok: false, reason: 'unsupported-version' };
  }
  if (!Array.isArray(parsed.projects) || !parsed.projects.every(isProjectRecord)) {
    return { ok: false, reason: 'invalid-data' };
  }

  return {
    ok: true,
    records: parsed.projects.map(cloneProjectRecord),
  };
}

function resolveDefaultStorage(): WebProjectStorage | null {
  return globalThis.localStorage ?? null;
}

export function createWebProjectStateAdapter(
  options: CreateWebProjectStateAdapterOptions = {}
): WebProjectStateAdapter {
  const storageKey = options.storageKey ?? WEB_PROJECT_STATE_STORAGE_KEY;
  const configuredStorage = options.storage;
  const resolveStorage: () => WebProjectStorage | null = typeof configuredStorage === 'function'
    ? configuredStorage
    : configuredStorage === undefined
      ? resolveDefaultStorage
      : () => configuredStorage;
  const records = new Map<string, ProjectRecord>();
  let isLoaded = false;
  let activeStorage: WebProjectStorage | null = null;
  let storageStatus: WebProjectStorageStatus = { mode: 'pending' };

  const fallBackToMemory = (reason: WebProjectStorageFallbackReason): void => {
    if (storageStatus.mode === 'memory') {
      return;
    }
    activeStorage = null;
    storageStatus = { mode: 'memory', reason };
    options.onStatusChange?.(storageStatus);
  };

  const ensureLoaded = (): void => {
    if (isLoaded) {
      return;
    }
    isLoaded = true;

    try {
      activeStorage = resolveStorage();
    } catch {
      fallBackToMemory('unavailable');
      return;
    }

    if (!activeStorage) {
      fallBackToMemory('unavailable');
      return;
    }

    let raw: string | null;
    try {
      raw = activeStorage.getItem(storageKey);
    } catch {
      fallBackToMemory('read-failed');
      return;
    }

    if (raw === null) {
      storageStatus = { mode: 'persistent' };
      return;
    }

    const parsed = parsePersistedState(raw);
    if (!parsed.ok) {
      fallBackToMemory(parsed.reason);
      return;
    }

    for (const record of parsed.records) {
      records.set(record.id, record);
    }
    storageStatus = { mode: 'persistent' };
  };

  const persistRecords = (): void => {
    if (storageStatus.mode !== 'persistent' || !activeStorage) {
      return;
    }

    const payload: PersistedWebProjectStateV1 = {
      version: WEB_PROJECT_STATE_VERSION,
      projects: Array.from(records.values(), cloneProjectRecord),
    };
    try {
      activeStorage.setItem(storageKey, JSON.stringify(payload));
    } catch {
      fallBackToMemory('write-failed');
    }
  };

  return {
    listProjectSummaries: async () => {
      ensureLoaded();
      return Array.from(records.values(), toProjectSummary)
        .sort((left, right) => right.updatedAt - left.updatedAt);
    },
    getProjectRecord: async (projectId) => {
      ensureLoaded();
      const record = records.get(projectId);
      return record ? cloneProjectRecord(record) : null;
    },
    upsertProjectRecord: async (record) => {
      ensureLoaded();
      records.set(record.id, cloneProjectRecord(record));
      persistRecords();
    },
    updateProjectViewportRecord: async (projectId, viewportJson) => {
      ensureLoaded();
      const record = records.get(projectId);
      if (!record) {
        return;
      }
      records.set(projectId, {
        ...record,
        viewportJson,
      });
      persistRecords();
    },
    renameProjectRecord: async (projectId, name, updatedAt) => {
      ensureLoaded();
      const record = records.get(projectId);
      if (!record) {
        return;
      }
      records.set(projectId, {
        ...record,
        name,
        updatedAt,
      });
      persistRecords();
    },
    deleteProjectRecord: async (projectId) => {
      ensureLoaded();
      if (!records.delete(projectId)) {
        return;
      }
      persistRecords();
    },
    getStorageStatus: () => storageStatus,
  };
}

type WebProjectStorageStatusListener = (status: WebProjectStorageStatus) => void;

const storageStatusListeners = new Set<WebProjectStorageStatusListener>();
const defaultWebProjectStateAdapter = createWebProjectStateAdapter({
  onStatusChange: (status) => {
    console.warn('[projectState] browser persistence unavailable; using session memory', {
      reason: status.mode === 'memory' ? status.reason : undefined,
    });
    storageStatusListeners.forEach((listener) => listener(status));
  },
});

export function subscribeWebProjectStorageStatus(
  listener: WebProjectStorageStatusListener
): () => void {
  storageStatusListeners.add(listener);
  const currentStatus = defaultWebProjectStateAdapter.getStorageStatus();
  if (currentStatus.mode === 'memory') {
    listener(currentStatus);
  }
  return () => {
    storageStatusListeners.delete(listener);
  };
}

export function listWebProjectSummaries(): Promise<ProjectSummaryRecord[]> {
  return defaultWebProjectStateAdapter.listProjectSummaries();
}

export function getWebProjectRecord(projectId: string): Promise<ProjectRecord | null> {
  return defaultWebProjectStateAdapter.getProjectRecord(projectId);
}

export function upsertWebProjectRecord(record: ProjectRecord): Promise<void> {
  return defaultWebProjectStateAdapter.upsertProjectRecord(record);
}

export function updateWebProjectViewportRecord(
  projectId: string,
  viewportJson: string
): Promise<void> {
  return defaultWebProjectStateAdapter.updateProjectViewportRecord(projectId, viewportJson);
}

export function renameWebProjectRecord(
  projectId: string,
  name: string,
  updatedAt: number
): Promise<void> {
  return defaultWebProjectStateAdapter.renameProjectRecord(projectId, name, updatedAt);
}

export function deleteWebProjectRecord(projectId: string): Promise<void> {
  return defaultWebProjectStateAdapter.deleteProjectRecord(projectId);
}
