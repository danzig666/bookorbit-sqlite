import { describe, expect, it } from 'vitest';

import { isVirtualRoot, isWindowsAbsolutePath } from './windows-roots';

describe('isWindowsAbsolutePath', () => {
  it.each(['C:\\', 'D:\\Books', 'G:\\BT\\eBook', 'g:/bt/ebook', 'E:', '\\\\nas\\books', '\\\\nas\\books\\ebook', '//nas/books'])(
    'accepts %s',
    (path) => {
      expect(isWindowsAbsolutePath(path)).toBe(true);
    },
  );

  it.each(['', '/books', 'books', 'C:books', '\\books', '\\\\nas', '\\\\?\\C:\\Windows', '\\\\.\\PhysicalDrive0'])('rejects %s', (path) => {
    expect(isWindowsAbsolutePath(path)).toBe(false);
  });
});

describe('isVirtualRoot', () => {
  it('only applies on Windows', () => {
    expect(isVirtualRoot('/')).toBe(process.platform === 'win32');
    expect(isVirtualRoot('/books')).toBe(false);
  });
});
