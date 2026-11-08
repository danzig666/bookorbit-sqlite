import { describe, expect, it } from 'vitest'
import {
  consolidateFolderPaths,
  folderLeafName,
  folderSegments,
  isAbsoluteFolderPath,
  isPathInside,
  normalizeFolderPath,
  parentFolderPath,
} from '../folder-paths'

describe('Windows folder paths', () => {
  it('normalizes drive and network share paths', () => {
    expect(normalizeFolderPath('g:/BT/eBook/')).toBe('G:\\BT\\eBook')
    expect(normalizeFolderPath('D:')).toBe('D:\\')
    expect(normalizeFolderPath('D:\\')).toBe('D:\\')
    expect(normalizeFolderPath('\\\\nas\\books\\')).toBe('\\\\nas\\books')
    expect(normalizeFolderPath('//nas/books/ebook')).toBe('\\\\nas\\books\\ebook')
  })

  it('accepts drive, share and posix paths as full paths', () => {
    expect(isAbsoluteFolderPath('G:\\BT\\eBook')).toBe(true)
    expect(isAbsoluteFolderPath('\\\\nas\\books')).toBe(true)
    expect(isAbsoluteFolderPath('/books')).toBe(true)
    expect(isAbsoluteFolderPath('books')).toBe(false)
  })

  it('walks up to the drive and then to the list of drives', () => {
    expect(parentFolderPath('G:\\BT\\eBook')).toBe('G:\\BT')
    expect(parentFolderPath('G:\\BT')).toBe('G:\\')
    expect(parentFolderPath('G:\\')).toBe('/')
    expect(parentFolderPath('\\\\nas\\books\\ebook')).toBe('\\\\nas\\books')
    expect(parentFolderPath('\\\\nas\\books')).toBe('/')
    expect(parentFolderPath('/books/fiction')).toBe('/books')
  })

  it('names drives, shares and folders', () => {
    expect(folderLeafName('G:\\')).toBe('G:')
    expect(folderLeafName('G:\\BT\\eBook')).toBe('eBook')
    expect(folderLeafName('\\\\nas\\books')).toBe('\\\\nas\\books')
    expect(folderSegments('G:\\BT\\eBook')).toEqual(['G:', 'BT', 'eBook'])
    expect(folderSegments('\\\\nas\\books\\ebook')).toEqual(['\\\\nas\\books', 'ebook'])
  })

  it('compares containment with the Windows separator', () => {
    expect(isPathInside('G:\\BT\\eBook', 'G:\\BT')).toBe(true)
    expect(isPathInside('G:\\BT\\eBook', 'G:\\')).toBe(true)
    expect(isPathInside('G:\\BT2', 'G:\\BT')).toBe(false)
    expect(isPathInside('G:\\BT', '/')).toBe(true)
    expect(isPathInside('\\\\nas\\books\\a', '\\\\nas\\books')).toBe(true)
    expect(consolidateFolderPaths(['G:\\BT\\eBook', 'G:\\BT', 'D:\\Books'])).toEqual(['G:\\BT', 'D:\\Books'])
  })
})
