// Package policy is the local policy every Linux tool applies itself: a command allow-list, a work-directory jail
// that survives symlinks, an output cap and a timeout. It holds even against a compromised gateway.
package policy

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Error is a refusal by policy; tools report it as denied.
type Error struct{ msg string }

func (e *Error) Error() string { return e.msg }

// IsPolicyError reports whether err is a policy refusal.
func IsPolicyError(err error) bool {
	var pe *Error
	return errors.As(err, &pe)
}

// DefaultDenyCommands are refused even when everything is allowed.
var DefaultDenyCommands = []string{"rm", "dd", "mkfs", "shutdown", "reboot", "halt", "poweroff", "sudo", "su", "doas", "mount", "umount"}

// Options describe one connector's policy.
type Options struct {
	// WorkDir is the only directory the connector may read and write. It must exist.
	WorkDir string
	// AllowCommands are program names (basename or absolute path) run_command may execute; "*" allows any.
	AllowCommands []string
	// DenyCommands are always refused.
	DenyCommands []string
	// MaxOutputBytes caps captured output.
	MaxOutputBytes int
	// CommandTimeout bounds one command; requests may shorten it, never lengthen it.
	CommandTimeout time.Duration
	// ReadOnly disables write_file and other mutating file operations.
	ReadOnly bool
}

// Policy is an immutable, resolved policy.
type Policy struct {
	WorkDir string
	opts    Options
}

// New resolves the work directory (following symlinks) and validates the options.
func New(opts Options) (*Policy, error) {
	if opts.MaxOutputBytes <= 0 {
		opts.MaxOutputBytes = 200_000
	}
	if opts.CommandTimeout <= 0 {
		opts.CommandTimeout = 60 * time.Second
	}
	if opts.DenyCommands == nil {
		opts.DenyCommands = DefaultDenyCommands
	}
	real, err := filepath.EvalSymlinks(opts.WorkDir)
	if err != nil {
		return nil, &Error{fmt.Sprintf("work directory does not exist: %s", opts.WorkDir)}
	}
	abs, err := filepath.Abs(real)
	if err != nil {
		return nil, err
	}
	return &Policy{WorkDir: abs, opts: opts}, nil
}

// ReadOnly reports whether writes are disabled.
func (p *Policy) ReadOnly() bool { return p.opts.ReadOnly }

// MaxOutputBytes is the output cap.
func (p *Policy) MaxOutputBytes() int { return p.opts.MaxOutputBytes }

// AllowCommands returns the configured allow-list.
func (p *Policy) AllowCommands() []string { return append([]string(nil), p.opts.AllowCommands...) }

// ResolvePath resolves input (absolute or relative to the work directory) and proves it stays inside the jail
// after following symlinks. For writes, the deepest existing ancestor is checked so a new file cannot be created
// through a symlinked parent that points outside.
func (p *Policy) ResolvePath(input string, write bool) (string, error) {
	if write && p.opts.ReadOnly {
		return "", &Error{"connector is in read-only mode"}
	}
	if strings.ContainsRune(input, 0) {
		return "", &Error{"invalid path"}
	}
	var candidate string
	if filepath.IsAbs(input) {
		candidate = filepath.Clean(input)
	} else {
		candidate = filepath.Clean(filepath.Join(p.WorkDir, input))
	}
	existing := candidate
	var missing []string
	for {
		if _, err := os.Lstat(existing); err == nil {
			break
		}
		parent := filepath.Dir(existing)
		if parent == existing {
			return "", &Error{"path has no existing ancestor"}
		}
		missing = append([]string{filepath.Base(existing)}, missing...)
		existing = parent
	}
	real, err := filepath.EvalSymlinks(existing)
	if err != nil {
		return "", &Error{fmt.Sprintf("cannot resolve path: %s", input)}
	}
	final := filepath.Join(append([]string{real}, missing...)...)
	if final != p.WorkDir && !strings.HasPrefix(final, p.WorkDir+string(filepath.Separator)) {
		return "", &Error{fmt.Sprintf("path is outside the work directory: %s", input)}
	}
	for _, part := range missing {
		if part == ".." {
			return "", &Error{fmt.Sprintf("path is outside the work directory: %s", input)}
		}
	}
	return final, nil
}

// CheckCommand validates argv against the deny-list and the allow-list. Programs are compared by basename and by
// full path.
func (p *Policy) CheckCommand(argv []string) error {
	if len(argv) == 0 {
		return &Error{"argv must be a non-empty list of strings"}
	}
	program := argv[0]
	if program == "" {
		return &Error{"argv must be a non-empty list of strings"}
	}
	name := filepath.Base(program)
	matches := func(list []string) bool {
		for _, entry := range list {
			if entry == program || entry == name {
				return true
			}
		}
		return false
	}
	if matches(p.opts.DenyCommands) {
		return &Error{fmt.Sprintf("command is denied by policy: %s", name)}
	}
	if !contains(p.opts.AllowCommands, "*") && !matches(p.opts.AllowCommands) {
		return &Error{fmt.Sprintf("command is not on the allow-list: %s", name)}
	}
	return nil
}

// Timeout returns the effective deadline for a command that asked for requestedSeconds (0 = policy default).
func (p *Policy) Timeout(requestedSeconds int) time.Duration {
	if requestedSeconds <= 0 {
		return p.opts.CommandTimeout
	}
	requested := time.Duration(requestedSeconds) * time.Second
	if requested < p.opts.CommandTimeout {
		return requested
	}
	return p.opts.CommandTimeout
}

// CapOutput truncates text to the byte cap, keeping the beginning and a marker.
func (p *Policy) CapOutput(text string) (string, bool) {
	if len(text) <= p.opts.MaxOutputBytes {
		return text, false
	}
	return text[:p.opts.MaxOutputBytes] + fmt.Sprintf("\n…[truncated %d bytes]", len(text)-p.opts.MaxOutputBytes), true
}

func contains(list []string, value string) bool {
	for _, v := range list {
		if v == value {
			return true
		}
	}
	return false
}
