# GT Universe — application skeleton

AMS2 GT career manager.  This is the shell only: it installs, opens,
creates a database from `resources/schema.sql`, shows the hub map and
advances weeks.  No season logic yet.

## Getting the installer without installing anything

The repository builds itself on GitHub's Windows machines.

1. Push this folder to a GitHub repository.
2. Open the **Actions** tab, pick **Build Windows installer**,
   press **Run workflow**.
3. Wait 5-8 minutes.
4. Open the **Releases** page on the right of the repository home and
   download the .exe from the newest build.

The installer is published as a release rather than a build artifact.
Artifacts come out of a 500 MB quota that a ninety-megabyte installer
fills in five or six runs, and once that is full the upload fails even
though the build itself worked.  A release does not touch the quota, and
the .exe downloads directly instead of arriving inside a zip.

The produced installer is self contained: Electron, the Node runtime and
the compiled better-sqlite3 are all inside it.  Whoever runs it needs
nothing installed.

Because the installer is unsigned, Windows will show
"Windows protected your PC" the first time.  More info -> Run anyway.

## Building locally instead (optional)

    npm install
    npm start            # run from source
    npm run dist         # dist/GTUniverse-Setup-0.1.0.exe

This route needs Node.js and the Visual Studio Build Tools with the
"Desktop development with C++" workload, because better-sqlite3 is
compiled from source.

## Layout

    electron/main.js     window, IPC, save folder, quit confirmation
    electron/db.js       better-sqlite3: create / open / peek / advance
    electron/preload.js  contextBridge, the only surface the UI can see
    renderer/            title, create and hub screens, canvas city map
    resources/           schema.sql, car_specs.json, car_images/

Three fixed save slots: `%APPDATA%/GT Universe/saves/slot1.db`, `slot2.db`,
`slot3.db`.  Never next to the exe, so uninstalling keeps them.  A slot
must be deleted before it can hold a new career; deletion asks for
confirmation and removes the `-wal` and `-shm` files with it.

## What to verify first

1. `npm install` completes and better-sqlite3 rebuilds without errors.
2. `npm start` opens a window with the title screen.
3. New career into an empty slot writes slot*.db and the hub map appears.
4. Advance week increments the counter and survives a restart.
5. `npm run dist` produces a working installer.

Step 5 is the fragile one: unsigned installers get flagged by
SmartScreen and some antivirus.  Test it early.
