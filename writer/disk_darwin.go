package main

import (
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strings"

	"golang.org/x/sys/unix"
	"howett.net/plist"
)

func diskutil(result any, args ...string) error {
	data, err := exec.Command("/usr/sbin/diskutil", args...).Output()
	if err != nil {
		return err
	}
	_, err = plist.Unmarshal(data, result)
	return err
}

type macPartition struct {
	Content, MountPoint string
	Partitions          []macPartition
}

func safeMacVolumes(part macPartition) bool {
	if strings.Contains(part.Content, "APFS") || strings.Contains(part.Content, "CoreStorage") || strings.EqualFold(part.Content, "7C3457EF-0000-11AA-AA11-00306543ECAC") || strings.EqualFold(part.Content, "53746F72-6167-11AA-AA11-00306543ECAC") || (part.MountPoint != "" && !strings.HasPrefix(part.MountPoint, "/Volumes/")) {
		return false
	}
	for _, child := range part.Partitions {
		if !safeMacVolumes(child) {
			return false
		}
	}
	return true
}
func listDisks() ([]disk, error) {
	var list struct {
		AllDisksAndPartitions []struct {
			DeviceIdentifier    string
			Content, MountPoint string
			Partitions          []macPartition
		}
	}
	if err := diskutil(&list, "list", "-plist", "external", "physical"); err != nil {
		return nil, err
	}
	found := []disk{}
	for _, entry := range list.AllDisksAndPartitions {
		if !regexp.MustCompile(`^disk[0-9]+$`).MatchString(entry.DeviceIdentifier) || !safeMacVolumes(macPartition{entry.Content, entry.MountPoint, entry.Partitions}) {
			continue
		}
		var info struct {
			Internal, WholeDisk, Writable, Ejectable, RemovableMedia bool
			TotalSize, DeviceBlockSize                               int64
			MediaName, DeviceTreePath, MediaUUID, BusProtocol        string
		}
		path := "/dev/" + entry.DeviceIdentifier
		if err := diskutil(&info, "info", "-plist", path); err != nil {
			continue
		}
		if info.Internal || !info.WholeDisk || !info.Writable || !(info.Ejectable || info.RemovableMedia) || info.TotalSize <= 0 {
			continue
		}
		var stat unix.Stat_t
		if err := unix.Lstat(path, &stat); err != nil || stat.Mode&unix.S_IFMT != unix.S_IFBLK {
			continue
		}
		identity := fmt.Sprintf("%s/%s/%s/%d/%v", info.DeviceTreePath, info.MediaUUID, info.BusProtocol, stat.Ino, stat.Btim)
		found = append(found, newDisk(path, info.MediaName, identity, info.TotalSize, info.DeviceBlockSize))
	}
	return found, nil
}
func openDisk(target disk) (*os.File, func(), error) {
	if out, err := exec.Command("/usr/sbin/diskutil", "unmountDisk", target.path).CombinedOutput(); err != nil {
		return nil, nil, fmt.Errorf("unmount: %s: %w", out, err)
	}
	file, err := os.OpenFile(target.path, os.O_RDWR|unix.O_EXCL|unix.O_NOFOLLOW|unix.O_EXLOCK|unix.O_NONBLOCK, 0)
	if err != nil {
		return nil, nil, err
	}
	_, err = findDisk(target.ID)
	if err == nil {
		opened, openErr := file.Stat()
		current, pathErr := os.Stat(target.path)
		if openErr != nil || pathErr != nil || !os.SameFile(opened, current) {
			err = fmt.Errorf("disk changed during open")
		}
	}
	if err != nil {
		file.Close()
		return nil, nil, err
	}
	return file, func() {}, nil
}
