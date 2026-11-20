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
)

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

func hashBytes(reader io.Reader, length int64) (string, error) {
	sum := sha256.New()
	_, err := io.CopyN(sum, reader, length)
	return hex.EncodeToString(sum.Sum(nil)), err
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
	digest, err := hashBytes(source, req.Size)
	if err != nil {
		return err
	}
	if digest != req.SHA256 {
		return errors.New("selected file does not match the prepared image")
	}
	if _, err = source.Seek(0, io.SeekStart); err != nil {
		return err
	}
	target, err := findDisk(req.Disk)
	if err != nil {
		return err
	}
	if target.sector <= 0 || req.Size > target.Capacity || req.Size%target.sector != 0 {
		return errors.New("image exceeds the disk capacity or is not sector-aligned")
	}
	media, release, err := openDisk(target)
	if err != nil {
		return err
	}
	defer release()
	defer media.Close()
	return writeImage(source, media, req.Size, req.SHA256)
}

func writeImage(source io.Reader, media *os.File, size int64, expected string) error {
	if _, err := io.CopyN(media, source, size); err != nil {
		return err
	}
	if err := media.Sync(); err != nil {
		return err
	}
	if _, err := media.Seek(0, io.SeekStart); err != nil {
		return err
	}
	digest, err := hashBytes(media, size)
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
