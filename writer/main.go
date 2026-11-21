package main

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"
)

const diskIdleTimeout = 5 * time.Minute

type ioWatchdog struct {
	timer *time.Timer
	idle  time.Duration
}

func watchIO(idle time.Duration) ioWatchdog {
	return ioWatchdog{idle: idle, timer: time.AfterFunc(idle, func() {
		fmt.Fprintln(os.Stderr, "Disk operation timed out without progress. Check the target and retry the full write.")
		os.Exit(124)
	})}
}

func (watch ioWatchdog) Write(data []byte) (int, error) {
	if len(data) != 0 {
		watch.timer.Reset(watch.idle)
	}
	return len(data), nil
}

type disk struct {
	ID       string `json:"id"`
	Label    string `json:"label"`
	Capacity int64  `json:"capacity"`
	path     string
	sector   int64
	mounts   []string
}

func newDisk(path, model, identity string, capacity, sector int64) disk {
	fingerprint := fmt.Sprintf("%s\x00%s\x00%s\x00%d\x00%d", path, model, identity, capacity, sector)
	return disk{ID: fmt.Sprintf("%x", sha256.Sum256([]byte(fingerprint))), Label: fmt.Sprintf("%s · %.1f GB · %s", model, float64(capacity)/1e9, path), Capacity: capacity, path: path, sector: sector}
}

type request struct {
	Disk   string
	Source string
	SHA256 string
	Size   int64
}

func findDisk(id string) (disk, error) {
	disks, err := listDisks()
	if err != nil {
		return disk{}, err
	}
	for _, target := range disks {
		if target.ID == id {
			return target, nil
		}
	}
	return disk{}, errors.New("selected removable disk is no longer available")
}

func hashBytes(reader io.Reader, length int64, watch ioWatchdog) (string, error) {
	sum := sha256.New()
	_, err := io.CopyN(io.MultiWriter(sum, watch), reader, length)
	return hex.EncodeToString(sum.Sum(nil)), err
}

func openSelectedDisk(id string, size int64) (disk, *os.File, func(), error) {
	watch := watchIO(diskIdleTimeout)
	defer watch.timer.Stop()
	target, err := findDisk(id)
	if err != nil {
		return disk{}, nil, nil, err
	}
	if target.sector <= 0 || size > target.Capacity || size%target.sector != 0 {
		return disk{}, nil, nil, errors.New("image exceeds the disk capacity or is not sector-aligned")
	}
	media, release, err := openDisk(target)
	if err != nil {
		return disk{}, nil, nil, err
	}
	return target, media, release, nil
}

func flash(req request) error {
	if !filepath.IsAbs(req.Source) || req.Size <= 0 || len(req.SHA256) != 64 {
		return errors.New("invalid image request")
	}
	source, err := os.Open(req.Source)
	if err != nil {
		return err
	}
	defer source.Close()
	info, err := source.Stat()
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Size() != req.Size {
		return errors.New("image file or size changed")
	}
	validation := watchIO(diskIdleTimeout)
	digest, err := hashBytes(source, req.Size, validation)
	validation.timer.Stop()
	if err != nil {
		return err
	}
	if digest != req.SHA256 {
		return errors.New("selected file does not match the prepared image")
	}
	if _, err = source.Seek(0, io.SeekStart); err != nil {
		return err
	}
	_, media, release, err := openSelectedDisk(req.Disk, req.Size)
	if err != nil {
		return err
	}
	watch := watchIO(diskIdleTimeout)
	defer watch.timer.Stop()
	defer release()
	defer media.Close()
	return writeImage(source, media, req.Size, req.SHA256, watch)
}

func writeImage(source io.Reader, media *os.File, size int64, expected string, watch ioWatchdog) error {
	if _, err := io.CopyN(io.MultiWriter(media, watch), source, size); err != nil {
		return err
	}
	if err := media.Sync(); err != nil {
		return err
	}
	if _, err := media.Seek(0, io.SeekStart); err != nil {
		return err
	}
	digest, err := hashBytes(media, size, watch)
	if err != nil {
		return err
	}
	if digest != expected {
		return errors.New("disk read-back SHA-256 mismatch")
	}
	return nil
}

func run(args []string) error {
	if len(args) == 1 && args[0] == "list" {
		disks, err := listDisks()
		if err != nil {
			return err
		}
		return json.NewEncoder(os.Stdout).Encode(disks)
	}
	if len(args) != 2 || args[0] != "write" {
		return errors.New("expected list or write")
	}
	payload, err := base64.RawURLEncoding.DecodeString(args[1])
	if err != nil {
		return err
	}
	var req request
	if err = json.Unmarshal(payload, &req); err != nil {
		return err
	}
	return flash(req)
}

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
