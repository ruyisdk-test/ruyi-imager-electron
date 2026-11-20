package main

import (
	"bytes"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"testing"
	"testing/synctest"
	"time"
)

func TestWriteAndReadBack(t *testing.T) {
	data := bytes.Repeat([]byte{0x5e, 0x1a}, 1024*1024)
	file, err := os.CreateTemp(t.TempDir(), "media")
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	sum := fmt.Sprintf("%x", sha256.Sum256(data))
	watch := watchIO(diskIdleTimeout)
	defer watch.timer.Stop()
	if err = writeImage(bytes.NewReader(data), file, int64(len(data)), sum, watch); err != nil {
		t.Fatal(err)
	}
	if _, err = file.Seek(0, 0); err != nil {
		t.Fatal(err)
	}
	if writeImage(bytes.NewReader(data), file, int64(len(data)), "wrong", watch) == nil {
		t.Fatal("accepted incorrect read-back")
	}
}

func TestWriterExitsAfterStalledIO(t *testing.T) {
	if os.Getenv("RUYI_TEST_STALLED_IO") == "1" {
		synctest.Test(t, func(t *testing.T) {
			watch := watchIO(diskIdleTimeout)
			reader, writer := io.Pipe()
			go func() {
				for range 4 {
					time.Sleep(diskIdleTimeout / 2)
					if _, err := writer.Write([]byte{1}); err != nil {
						return
					}
				}
				fmt.Fprintln(os.Stdout, "progress continued past the initial deadline")
			}()
			_, err := hashBytes(reader, 5, watch)
			t.Fatalf("stalled read returned: %v", err)
		})
		return
	}
	command := exec.Command(os.Args[0], "-test.run=^TestWriterExitsAfterStalledIO$")
	command.Env = append(os.Environ(), "RUYI_TEST_STALLED_IO=1")
	output, err := command.CombinedOutput()
	var exit *exec.ExitError
	if !errors.As(err, &exit) || exit.ExitCode() != 124 || !strings.Contains(string(output), "progress continued") || !strings.Contains(string(output), "timed out") {
		t.Fatalf("expected writer exit after stalled read: %v, %s", err, output)
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
