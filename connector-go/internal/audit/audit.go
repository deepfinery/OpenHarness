// Package audit writes one JSON line per tool call, to a file (mode 0600) or to stderr.
package audit

import (
	"encoding/json"
	"io"
	"os"
	"sync"
	"time"
)

// Log is safe for concurrent use.
type Log struct {
	mu   sync.Mutex
	out  io.Writer
	file *os.File
}

// Open returns a log writing to path, or to stderr when path is empty.
func Open(path string) (*Log, error) {
	if path == "" {
		return &Log{out: os.Stderr}, nil
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return nil, err
	}
	return &Log{out: f, file: f}, nil
}

// Write records one entry with a timestamp.
func (l *Log) Write(entry map[string]any) {
	if l == nil {
		return
	}
	record := map[string]any{"ts": time.Now().UTC().Format(time.RFC3339Nano), "type": "tool_call"}
	for k, v := range entry {
		record[k] = v
	}
	line, err := json.Marshal(record)
	if err != nil {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	_, _ = l.out.Write(append(line, '\n'))
}

// Close releases the file, if any.
func (l *Log) Close() error {
	if l != nil && l.file != nil {
		return l.file.Close()
	}
	return nil
}
