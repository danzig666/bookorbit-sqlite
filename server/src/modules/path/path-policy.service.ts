import type { ConfigType } from '@nestjs/config';
import { BadRequestException, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { realpath } from 'fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'path';

import { storageConfig } from '../../config/config';
import { IS_WINDOWS, isVirtualRoot, isWindowsAbsolutePath, listWindowsDrives, WINDOWS_VIRTUAL_ROOT } from './windows-roots';

const MAX_BROWSE_PATH_LENGTH = 4096;

@Injectable()
export class PathPolicyService {
  private readonly browseRoot: string;
  /** Windows only: configured roots; empty allows every drive and network share. */
  private readonly windowsRoots: string[];
  private readonly appDataPath: string | null;
  private canonicalBrowseRootPromise: Promise<string> | null = null;
  private canonicalAppDataPathPromise: Promise<string | null> | null = null;
  private readonly canonicalWindowsRoots = new Map<string, Promise<string>>();

  constructor(@Inject(storageConfig.KEY) storage: ConfigType<typeof storageConfig>) {
    this.windowsRoots = IS_WINDOWS ? (storage.libraryBrowseRoots ?? []) : [];
    this.browseRoot = IS_WINDOWS ? WINDOWS_VIRTUAL_ROOT : resolve(storage.libraryBrowseRoot);
    this.appDataPath = storage.appDataPath ? resolve(storage.appDataPath) : null;
  }

  getBrowseRoot(): string {
    return this.browseRoot;
  }

  /** The folders shown at the Windows top level: the configured roots, or every drive that answers. */
  async listWindowsRoots(): Promise<string[]> {
    return this.windowsRoots.length > 0 ? this.windowsRoots : listWindowsDrives();
  }

  getAppDataPath(): string | null {
    return this.appDataPath;
  }

  /** The data folder with symlinks resolved, so it matches paths read from the disk. */
  getCanonicalAppDataPath(): Promise<string | null> {
    if (!this.appDataPath) return Promise.resolve(null);
    this.canonicalAppDataPathPromise ??= realpath(this.appDataPath).catch(() => this.appDataPath);
    return this.canonicalAppDataPathPromise;
  }

  async resolveBrowsePath(rawPath?: string | null): Promise<string> {
    const inputPath = typeof rawPath === 'string' ? rawPath.trim() : '';
    if (inputPath.length > MAX_BROWSE_PATH_LENGTH) throw new BadRequestException('Path is too long');

    if (IS_WINDOWS) {
      if (isVirtualRoot(inputPath)) throw new BadRequestException('Choose a drive or folder');
      if (!isWindowsAbsolutePath(inputPath)) throw new BadRequestException('Enter a full path, for example D:\\Books or \\\\server\\share');
    }

    const path = resolve(inputPath || this.browseRoot);
    await this.assertWithinBrowseRoot(path);
    return path;
  }

  async assertWithinBrowseRoot(rawPath: string): Promise<string> {
    const path = resolve(rawPath);
    if (!(await this.isWithinBrowseRoot(path))) {
      throw new ForbiddenException('Path is outside the configured library browse root');
    }
    return path;
  }

  async isWithinBrowseRoot(rawPath: string): Promise<boolean> {
    if (typeof rawPath !== 'string' || rawPath.length > MAX_BROWSE_PATH_LENGTH) return false;
    if (IS_WINDOWS) return this.isWithinWindowsRoots(rawPath);

    return this.isWithinRoot(rawPath, this.browseRoot, await this.getCanonicalBrowseRoot());
  }

  async assertWithinRoot(rawPath: string, rawRoot: string): Promise<string> {
    const root = resolve(rawRoot);
    const canonicalRoot = await canonicalizeWithExistingAncestor(root);
    if (!(await this.isWithinRoot(rawPath, root, canonicalRoot))) {
      throw new ForbiddenException('Resolved path is outside the authorized root');
    }
    return resolve(rawPath);
  }

  private async isWithinRoot(rawPath: string, rootPath: string, canonicalRoot: string): Promise<boolean> {
    if (typeof rawPath !== 'string' || rawPath.length > MAX_BROWSE_PATH_LENGTH) return false;

    const resolvedPath = resolve(rawPath);
    const lexicalRelativePath = relative(rootPath, resolvedPath);
    if (lexicalRelativePath === '..' || lexicalRelativePath.startsWith(`..${sep}`) || isAbsolute(lexicalRelativePath)) return false;

    const suffixSegments: string[] = [];
    let current = resolvedPath;
    let canonicalPath: string;

    while (true) {
      try {
        const canonicalAncestor = await realpath(current);
        canonicalPath = suffixSegments.reduceRight((built, segment) => join(built, segment), canonicalAncestor);
        break;
      } catch (error) {
        const code = getErrorCode(error);
        if (code !== 'ENOENT' && code !== 'ENOTDIR') return false;
      }

      const parent = dirname(current);
      if (parent === current) return false;

      suffixSegments.push(basename(current));
      current = parent;
    }

    const canonicalRelativePath = relative(canonicalRoot, canonicalPath);
    return (
      canonicalRelativePath === '' ||
      (!canonicalRelativePath.startsWith(`..${sep}`) && canonicalRelativePath !== '..' && !isAbsolute(canonicalRelativePath))
    );
  }

  private async isWithinWindowsRoots(rawPath: string): Promise<boolean> {
    if (!isWindowsAbsolutePath(rawPath)) return false;
    if (this.windowsRoots.length === 0) return true;
    for (const root of this.windowsRoots) {
      let canonical = this.canonicalWindowsRoots.get(root);
      if (!canonical) {
        canonical = canonicalizeWithExistingAncestor(root);
        this.canonicalWindowsRoots.set(root, canonical);
      }
      if (await this.isWithinRoot(rawPath, root, await canonical)) return true;
    }
    return false;
  }

  private getCanonicalBrowseRoot(): Promise<string> {
    this.canonicalBrowseRootPromise ??= canonicalizeWithExistingAncestor(this.browseRoot);
    return this.canonicalBrowseRootPromise;
  }
}

async function canonicalizeWithExistingAncestor(resolvedPath: string): Promise<string> {
  const suffixSegments: string[] = [];
  let current = resolvedPath;

  while (true) {
    try {
      const canonical = await realpath(current);
      return suffixSegments.reduceRight((built, segment) => join(built, segment), canonical);
    } catch (error) {
      const code = getErrorCode(error);
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        return resolvedPath;
      }
    }

    const parent = dirname(current);
    if (parent === current) return resolvedPath;

    suffixSegments.push(basename(current));
    current = parent;
  }
}

function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}
