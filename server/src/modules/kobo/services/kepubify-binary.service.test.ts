vi.mock('fs/promises', () => ({
  chmod: vi.fn(),
  stat: vi.fn(),
}));

import { chmod, stat } from 'fs/promises';
import { join } from 'path';

import { KepubifyBinaryService } from './kepubify-binary.service';

const chmodMock = vi.mocked(chmod);
const statMock = vi.mocked(stat);

function makeService() {
  return new KepubifyBinaryService();
}

describe('KepubifyBinaryService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('detectBinaryName', () => {
    it.each([
      ['darwin', 'arm64', 'kepubify-darwin-arm64'],
      ['darwin', 'x64', 'kepubify-darwin-64bit'],
      ['linux', 'x64', 'kepubify-linux-64bit'],
      ['linux', 'arm64', 'kepubify-linux-arm64'],
      ['linux', 'arm', 'kepubify-linux-arm'],
      ['linux', 'ia32', 'kepubify-linux-32bit'],
      ['win32', 'x64', 'kepubify-windows-64bit.exe'],
    ])('platform=%s arch=%s → %s', (platform, arch, expected) => {
      const service = makeService();
      vi.spyOn(process, 'platform', 'get').mockReturnValue(platform as NodeJS.Platform);
      vi.spyOn(process, 'arch', 'get').mockReturnValue(arch);
      expect((service as any).detectBinaryName()).toBe(expected);
    });

    it('throws for unsupported platforms', () => {
      const service = makeService();
      vi.spyOn(process, 'platform', 'get').mockReturnValue('win32' as NodeJS.Platform);
      vi.spyOn(process, 'arch', 'get').mockReturnValue('arm64');
      expect(() => (service as any).detectBinaryName()).toThrow('Unsupported platform');
    });
  });

  describe('getBinaryPath', () => {
    it('caches result and only resolves once across multiple calls', async () => {
      const service = makeService();
      vi.spyOn(service as any, 'detectBinaryName').mockReturnValue('kepubify-linux-64bit');
      const resolveSpy = vi.spyOn(service as any, 'resolveBinaryPath').mockResolvedValue('/resolved/kepubify');

      const first = await service.getBinaryPath();
      const second = await service.getBinaryPath();

      expect(first).toBe('/resolved/kepubify');
      expect(second).toBe('/resolved/kepubify');
      expect(resolveSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('resolveBinaryPath', () => {
    it('returns bundled path when binary is present in bin/ dir', async () => {
      const service = makeService();
      const expectedBundled = join(process.cwd(), 'bin', 'kepubify', 'kepubify-linux-64bit');
      statMock.mockResolvedValueOnce({} as never);

      const result = await (service as any).resolveBinaryPath('kepubify-linux-64bit');

      expect(result).toBe(expectedBundled);
      expect(chmodMock).toHaveBeenCalledWith(expectedBundled, 0o755);
    });

    it('throws when bundled binary is missing', async () => {
      const service = makeService();
      statMock.mockRejectedValueOnce(new Error('ENOENT'));

      await expect((service as any).resolveBinaryPath('kepubify-linux-64bit')).rejects.toThrow('ENOENT');
    });

    it('still returns path when chmod fails (read-only filesystem)', async () => {
      const service = makeService();
      const expectedBundled = join(process.cwd(), 'bin', 'kepubify', 'kepubify-linux-64bit');
      statMock.mockResolvedValueOnce({} as never);
      chmodMock.mockRejectedValueOnce(new Error('EROFS'));

      const result = await (service as any).resolveBinaryPath('kepubify-linux-64bit');

      expect(result).toBe(expectedBundled);
    });
  });
});
