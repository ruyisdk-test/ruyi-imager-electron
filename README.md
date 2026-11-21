# Ruyi Imager desktop

The app opens the deployed RuyiSDK graphical imager. Use **Ruyi Imager → Device Provision** for the terminal wizard. Both pages run the website's package strategies. Fastboot uses Chromium WebUSB. For `dd-v1`, select a removable disk in the sidebar and confirm the flashing steps on the page. The Go writer verifies the extracted file, acquires the target, writes the image, and compares the disk read-back against the image SHA-256.

If image verification, writing, or read-back makes no progress for five minutes, the writer exits with a timeout. After a timeout, check the target disk and repeat the full write.

Build on the target OS with Node.js 24 or later and Go 1.25 or later. Run `npm ci` followed by `npm start` for development. For distribution, `npm run dist` produces both a `.deb` package and a `.tar.gz` archive on Linux, a disk image on macOS, or a portable executable on Windows. To use the Linux tarball, extract it and run `./ruyi-imager-electron` from the extracted directory. `npm test` runs desktop policy tests. Run `go test ./...` in `writer` for file-backed verification tests. The CI builds each package on its native OS.

Linux requires `lsblk`, a kernel exposing `diskseq`, and a working graphical polkit agent for `pkexec`. The writer accepts removable disks with ordinary partitions mounted under `/media` or `/run/media`, or already unmounted media. On macOS the app selects external physical media and excludes APFS and CoreStorage containers. On Windows the app selects USB, SD and MMC disks and requests UAC. Keep the working directory on a separate disk. When the browser's directory grant is unavailable to the host, select the extracted file in the native picker. The writer checks its content before opening the target for writing.
