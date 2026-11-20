package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"unsafe"

	"golang.org/x/sys/unix"
)

type linuxNode struct {
	Name, Type, Model, Tran, Serial string
	RM, RO, Hotplug                 bool
	Size                            int64
	Sector                          int64 `json:"log-sec"`
	Mountpoints                     []*string
	Children                        []linuxNode
}

func mediaMounts(node linuxNode) ([]string, bool) {
	var mounts []string
	for _, mount := range node.Mountpoints {
		if mount == nil {
			continue
		}
		if !strings.HasPrefix(*mount, "/media/") && !strings.HasPrefix(*mount, "/run/media/") {
			return nil, false
		}
		mounts = append(mounts, *mount)
	}
	for _, part := range node.Children {
		if part.Type != "part" {
			return nil, false
		}
		nested, ok := mediaMounts(part)
		if !ok {
			return nil, false
		}
		mounts = append(mounts, nested...)
	}
	return mounts, true
}

func listDisks() ([]disk, error) {
	data, err := exec.Command("/usr/bin/lsblk", "--json", "--bytes", "--tree", "--output", "NAME,TYPE,RM,RO,HOTPLUG,TRAN,SERIAL,SIZE,LOG-SEC,MODEL,MOUNTPOINTS").Output()
	if err != nil {
		return nil, err
	}
	var devices struct{ Blockdevices []linuxNode }
	if err = json.Unmarshal(data, &devices); err != nil {
		return nil, err
	}
	found := []disk{}
	for _, node := range devices.Blockdevices {
		if node.Type != "disk" || node.RO || node.Size <= 0 || (!node.RM && !(node.Hotplug && node.Tran == "usb")) {
			continue
		}
		mounts, ok := mediaMounts(node)
		if !ok {
			continue
		}
		seq, err := os.ReadFile(filepath.Join("/sys/class/block", node.Name, "diskseq"))
		if err != nil {
			continue
		}
		target := newDisk("/dev/"+node.Name, strings.TrimSpace(node.Model), strings.TrimSpace(string(seq))+":"+node.Serial, node.Size, node.Sector)
		target.mounts = mounts
		found = append(found, target)
	}
	return found, nil
}

func openDisk(target disk) (*os.File, func(), error) {
	for _, mount := range target.mounts {
		fresh, err := findDisk(target.ID)
		if err != nil {
			return nil, nil, err
		}
		owned := false
		for _, current := range fresh.mounts {
			if current == mount {
				owned = true
			}
		}
		if owned {
			if err := unix.Unmount(mount, 0); err != nil {
				return nil, nil, fmt.Errorf("unmount %s: %w", mount, err)
			}
		}
	}
	file, err := os.OpenFile(target.path, os.O_RDWR|unix.O_EXCL|unix.O_NOFOLLOW, 0)
	if err != nil {
		return nil, nil, err
	}
	fresh, err := findDisk(target.ID)
	if err == nil && len(fresh.mounts) > 0 {
		err = errors.New("target remounted")
	}
	if err == nil {
		seq, readErr := os.ReadFile(filepath.Join("/sys/class/block", filepath.Base(target.path), "diskseq"))
		var handleSeq uint64
		if readErr != nil {
			err = readErr
		} else {
			_, _, errno := unix.Syscall(unix.SYS_IOCTL, file.Fd(), unix.BLKGETDISKSEQ, uintptr(unsafe.Pointer(&handleSeq)))
			if errno != 0 {
				err = errno
			} else if strconv.FormatUint(handleSeq, 10) != strings.TrimSpace(string(seq)) {
				err = errors.New("disk changed during open")
			}
		}
	}
	if err != nil {
		file.Close()
		return nil, nil, err
	}
	return file, func() {}, nil
}
