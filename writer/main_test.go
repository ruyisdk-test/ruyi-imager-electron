package main

import (
	"bytes"
	"crypto/sha256"
	"fmt"
	"os"
	"testing"
)

func TestWriteAndReadBack(t *testing.T) {
	data := bytes.Repeat([]byte{0x5e, 0x1a}, 1024*1024)
	file, err := os.CreateTemp(t.TempDir(), "media")
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	sum := fmt.Sprintf("%x", sha256.Sum256(data))
	if err = writeImage(bytes.NewReader(data), file, int64(len(data)), sum); err != nil {
		t.Fatal(err)
	}
	if _, err = file.Seek(0, 0); err != nil {
		t.Fatal(err)
	}
	if writeImage(bytes.NewReader(data), file, int64(len(data)), "wrong") == nil {
		t.Fatal("accepted incorrect read-back")
	}
}

func TestChangedSourceRejectedBeforeDiskAccess(t *testing.T) {
	path := t.TempDir() + "/image"
	if err := os.WriteFile(path, make([]byte, 512), 0600); err != nil {
		t.Fatal(err)
	}
	err := flash(request{Source: path, Size: 512, SHA256: fmt.Sprintf("%064d", 0)})
	if err == nil || err.Error() != "selected file does not match the prepared image" {
		t.Fatal(err)
	}
}
