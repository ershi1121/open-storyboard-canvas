import { beforeEach, describe, expect, it, vi } from 'vitest';

const runtimeMocks = vi.hoisted(() => ({
  isTauri: vi.fn<() => boolean>(),
  getVersion: vi.fn<() => Promise<string>>(),
  checkLatestReleaseTag: vi.fn<() => Promise<string | null>>(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  isTauri: runtimeMocks.isTauri,
}));

vi.mock('@tauri-apps/api/app', () => ({
  getVersion: runtimeMocks.getVersion,
}));

vi.mock('../../../commands/update', () => ({
  checkLatestReleaseTag: runtimeMocks.checkLatestReleaseTag,
}));

import { checkForUpdate } from './checkForUpdate';

describe('checkForUpdate runtime boundary', () => {
  beforeEach(() => {
    runtimeMocks.isTauri.mockReset();
    runtimeMocks.getVersion.mockReset();
    runtimeMocks.checkLatestReleaseTag.mockReset();
  });

  it('does not invoke Tauri app/update commands in a browser', async () => {
    runtimeMocks.isTauri.mockReturnValue(false);

    await expect(checkForUpdate()).resolves.toEqual({ hasUpdate: false });
    expect(runtimeMocks.getVersion).not.toHaveBeenCalled();
    expect(runtimeMocks.checkLatestReleaseTag).not.toHaveBeenCalled();
  });

  it('keeps the native update path in Tauri', async () => {
    runtimeMocks.isTauri.mockReturnValue(true);
    runtimeMocks.getVersion.mockResolvedValue('1.0.0');
    runtimeMocks.checkLatestReleaseTag.mockResolvedValue('v1.1.0');

    await expect(checkForUpdate()).resolves.toMatchObject({
      hasUpdate: true,
      currentVersion: '1.0.0',
      latestVersion: '1.1.0',
    });
    expect(runtimeMocks.getVersion).toHaveBeenCalledTimes(1);
    expect(runtimeMocks.checkLatestReleaseTag).toHaveBeenCalledTimes(1);
  });
});
