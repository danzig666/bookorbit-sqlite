# BookOrbit for Windows (portable)

## 0.2.0

- The browser opens the first-run setup page with the setup token already filled in
- Library folders can be on any drive, mapped network drive or network share, for example `G:\BT\eBook` or `\\nas\books`
- The folder picker starts with a list of drives, and full Windows paths can be typed or pasted
- `LIBRARY_BROWSE_ROOT` accepts several folders separated by `;` to limit what the picker can open
- Windows system folders such as `Windows` and `Program Files` are hidden in the picker unless asked for

## 0.1.0

- Portable single-file Windows x64 build, no Docker or separate database install needed
- Embedded PostgreSQL 18.4 with pgvector 0.8.7, pg_trgm and unaccent
- Bundled kepubify 4.0.4, FFmpeg (LGPL build) and Poppler 26.09
- All data (database, covers, settings, logs) lives in `BookOrbit-data` next to the executable
- Settings such as `PORT` are in `BookOrbit-data\bookorbit.env`
- DjVu files are not supported in the portable build
