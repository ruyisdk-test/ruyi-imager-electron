package main

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"

	"golang.org/x/sys/windows"
)

const diskQuery = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$items = @(foreach ($disk in (Get-Disk)) {
    if ($disk.BusType -notin 'USB','SD','MMC' -or $disk.IsBoot -or $disk.IsSystem -or
        $disk.BootFromDisk -or $disk.IsReadOnly -or $disk.IsOffline -or $disk.Size -le 0) { continue }
    $parts = @(if ($disk.NumberOfPartitions -gt 0) { Get-Partition -DiskNumber $disk.Number })
    if ($parts | Where-Object { $_.IsBoot -or $_.IsSystem }) { continue }
    [PSCustomObject]@{
        number = $disk.Number; model = $disk.FriendlyName; serial = $disk.SerialNumber
        unique = $disk.UniqueId; path = $disk.Path; size = $disk.Size; sector = $disk.LogicalSectorSize
        volumes = @($parts | ForEach-Object { $_.AccessPaths } | Where-Object { $_ -like '\\?\Volume{*' })
    }
})
ConvertTo-Json -InputObject $items -Compress -Depth 4`

func listDisks() ([]disk, error) {
	system, err := windows.GetSystemDirectory()
	if err != nil {
		return nil, err
	}
	data, err := exec.Command(filepath.Join(system, "WindowsPowerShell", "v1.0", "powershell.exe"), "-NoProfile", "-NonInteractive", "-Command", diskQuery).Output()
	if err != nil {
		return nil, err
	}
	var rows []struct {
		Number                      uint32
		Model, Serial, Unique, Path string
		Size, Sector                int64
		Volumes                     []string
	}
	if err = json.Unmarshal(data, &rows); err != nil {
		return nil, err
	}
	found := []disk{}
	for _, row := range rows {
		if row.Path == "" || (strings.TrimSpace(row.Serial) == "" && row.Unique == "") {
			continue
		}
		path := fmt.Sprintf(`\\.\PhysicalDrive%d`, row.Number)
		target := newDisk(path, row.Model, row.Path+"/"+row.Serial+"/"+row.Unique, row.Size, row.Sector)
		target.mounts = row.Volumes
		found = append(found, target)
	}
	return found, nil
}

func diskHandle(path string) (windows.Handle, error) {
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return 0, err
	}
	return windows.CreateFile(name, windows.GENERIC_READ|windows.GENERIC_WRITE, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_WRITE_THROUGH, 0)
}
func control(handle windows.Handle, code uint32, out []byte) error {
	var length uint32
	var ptr *byte
	if len(out) > 0 {
		ptr = &out[0]
	}
	err := windows.DeviceIoControl(handle, code, nil, 0, ptr, uint32(len(out)), &length, nil)
	if err == nil && length < uint32(len(out)) {
		return errors.New("short device response")
	}
	return err
}

func openDisk(target disk) (*os.File, func(), error) {
	handle, err := diskHandle(target.path)
	if err != nil {
		return nil, nil, err
	}
	file := os.NewFile(uintptr(handle), target.path)
	locks := []windows.Handle{}
	release := func() {
		for _, lock := range locks {
			windows.CloseHandle(lock)
		}
	}
	fail := func(err error) (*os.File, func(), error) { release(); file.Close(); return nil, nil, err }
	var number [12]byte
	if err = control(handle, 0x2d1080, number[:]); err != nil {
		return fail(err)
	}
	if fmt.Sprintf(`\\.\PhysicalDrive%d`, binary.LittleEndian.Uint32(number[4:])) != target.path {
		return fail(errors.New("disk number changed"))
	}
	var size [8]byte
	if err = control(handle, 0x7405c, size[:]); err != nil {
		return fail(err)
	}
	if int64(binary.LittleEndian.Uint64(size[:])) != target.Capacity {
		return fail(errors.New("disk capacity changed"))
	}
	fresh, err := findDisk(target.ID)
	if err != nil {
		return fail(err)
	}
	for _, volume := range fresh.mounts {
		if !regexp.MustCompile(`(?i)^\\\\\?\\Volume\{[0-9a-f-]+\}\\$`).MatchString(volume) {
			return fail(errors.New("invalid volume path"))
		}
		lock, err := diskHandle(strings.TrimSuffix(volume, `\`))
		if err != nil {
			return fail(err)
		}
		locks = append(locks, lock)
		var device [12]byte
		if err = control(lock, 0x2d1080, device[:]); err != nil {
			return fail(err)
		}
		if binary.LittleEndian.Uint32(device[4:]) != binary.LittleEndian.Uint32(number[4:]) {
			return fail(errors.New("volume is on a different disk"))
		}
		if err = control(lock, 0x90018, nil); err != nil {
			return fail(fmt.Errorf("lock volume: %w", err))
		}
		if err = control(lock, 0x90020, nil); err != nil {
			return fail(fmt.Errorf("dismount volume: %w", err))
		}
	}
	return file, release, nil
}
