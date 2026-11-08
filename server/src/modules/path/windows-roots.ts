import { stat } from 'fs/promises';

export const IS_WINDOWS = process.platform === 'win32';

/** The top of the folder picker on Windows: not a real folder, it lists the drives (or configured roots). */
export const WINDOWS_VIRTUAL_ROOT = '/';

const DRIVE_PROBE_TIMEOUT_MS = 1_500;
const DRIVE_CACHE_TTL_MS = 30_000;

let driveCache: { drives: string[]; expires: number } | null = null;

export function isVirtualRoot(raw: string | null | undefined): boolean {
  if (!IS_WINDOWS) return false;
  const value = (raw ?? '').trim();
  return value === '' || value === '/' || value === '\\';
}

/** A drive path (`D:\Books`) or a UNC share path (`\\nas\books`), the forms a Windows folder can take. */
export function isWindowsAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || /^[A-Za-z]:$/.test(value) || /^[\\/]{2}[^\\/?.][^\\/]*[\\/]+[^\\/]+/.test(value);
}

function probeDrive(root: string): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), DRIVE_PROBE_TIMEOUT_MS);
    stat(root).then(
      (info) => {
        clearTimeout(timer);
        resolve(info.isDirectory());
      },
      () => {
        clearTimeout(timer);
        resolve(false);
      },
    );
  });
}

/** Drive roots that answer right now, including mapped network drives. Empty card readers are left out. */
export async function listWindowsDrives(): Promise<string[]> {
  if (driveCache && driveCache.expires > Date.now()) return driveCache.drives;
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  const present = await Promise.all(letters.map((letter) => probeDrive(`${letter}:\\`)));
  const drives = letters.filter((_, index) => present[index]).map((letter) => `${letter}:\\`);
  driveCache = { drives, expires: Date.now() + DRIVE_CACHE_TTL_MS };
  return drives;
}
