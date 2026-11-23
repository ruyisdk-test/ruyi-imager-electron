# Ruyi Imager desktop

The desktop app bundles its own interface, packages-index catalog, provisioning plugins and `ruyi-imager-core` WebAssembly runtime. Select a board, hardware variant, system and package versions to prepare an image. Fastboot uses Chromium WebUSB. For `dd-v1`, select a removable disk and review the flashing steps. The Go writer verifies the extracted file, acquires the target, writes the image, and compares the disk read-back against the image SHA-256.

Downloaded and manually imported archives are stored under Electron's `app.getPath('userData')` in `RuyiImages/<package>/<version>/downloads/`. Each run verifies the cached size and SHA-256 before contacting any mirror. Extraction uses Chromium's private storage in the application profile. For a native disk write the app stages one temporary copy of the extracted image in its data directory and removes it after the writer exits.

If image verification, writing, or read-back makes no progress for five minutes, the writer exits with a timeout. After a timeout, check the target disk and repeat the full write.

Build on the target OS with Node.js 24 or later, Python 3.14 or later (`python` on PATH) and Go 1.25 or later. Run `git submodule update --init`, `npm ci`, then `npm start` for development. `npm run build:renderer` searches GitHub and Gitee for the newest dated packages-index release from today (UTC) through 30 days ago. The catalog records its release date. Subsequent builds only check dates newer than the local catalog and reuse it when no update is available. Both the image index and the plugins come from the selected release.

For distribution, `npm run dist` produces both a `.deb` package and a `.tar.gz` archive on Linux, a disk image on macOS, or a portable executable on Windows. To use the Linux tarball, extract it and run `./ruyi-imager-electron` from the extracted directory. `npm test` runs the desktop and release lookup tests. Run `go test ./...` in `writer` for file-backed verification tests. The CI builds each package on its native OS.

Linux requires `lsblk`, a kernel exposing `diskseq`, and a working graphical polkit agent for `pkexec`. The writer accepts removable disks with ordinary partitions mounted under `/media` or `/run/media`, or already unmounted media. On macOS the app selects external physical media and excludes APFS and CoreStorage containers. On Windows the app selects USB, SD and MMC disks and requests UAC. The writer checks the source image before opening the target for writing.
