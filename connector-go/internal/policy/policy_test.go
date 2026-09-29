package policy

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestJailAllowListAndCaps(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "docs"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "escape")); err != nil {
		t.Fatal(err)
	}
	p, err := New(Options{WorkDir: root, AllowCommands: []string{"echo", "/usr/bin/id"}, MaxOutputBytes: 10, CommandTimeout: 5 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	if got, err := p.ResolvePath("docs/new.txt", true); err != nil || got != filepath.Join(p.WorkDir, "docs", "new.txt") {
		t.Fatalf("relative path inside the jail: %q %v", got, err)
	}
	if _, err := p.ResolvePath("../secret", false); err == nil || !IsPolicyError(err) {
		t.Fatal("dot-dot escape must be refused")
	}
	if _, err := p.ResolvePath("escape/file", true); err == nil {
		t.Fatal("writing through a symlink that leaves the jail must be refused")
	}
	if _, err := p.ResolvePath("escape", false); err == nil {
		t.Fatal("a symlink pointing outside must be refused")
	}
	if _, err := p.ResolvePath("/etc/passwd", false); err == nil {
		t.Fatal("absolute paths outside the jail must be refused")
	}
	if _, err := p.ResolvePath("a\x00b", false); err == nil {
		t.Fatal("NUL bytes are invalid")
	}
	if err := p.CheckCommand([]string{"echo", "hi"}); err != nil {
		t.Fatal(err)
	}
	if err := p.CheckCommand([]string{"/usr/bin/id"}); err != nil {
		t.Fatal(err)
	}
	if err := p.CheckCommand([]string{"rm", "-rf", "/"}); err == nil {
		t.Fatal("rm is denied by default")
	}
	if err := p.CheckCommand([]string{"curl"}); err == nil {
		t.Fatal("programs off the allow-list are refused")
	}
	if err := p.CheckCommand(nil); err == nil {
		t.Fatal("empty argv is refused")
	}
	if p.Timeout(0) != 5*time.Second || p.Timeout(1) != time.Second || p.Timeout(600) != 5*time.Second {
		t.Fatal("requests may shorten the timeout, never lengthen it")
	}
	if text, truncated := p.CapOutput("0123456789abc"); !truncated || text[:10] != "0123456789" {
		t.Fatalf("output cap: %q %v", text, truncated)
	}
	any, _ := New(Options{WorkDir: root, AllowCommands: []string{"*"}})
	if err := any.CheckCommand([]string{"anything"}); err != nil {
		t.Fatal("* allows any program")
	}
	if err := any.CheckCommand([]string{"sudo", "ls"}); err == nil {
		t.Fatal("the deny-list wins over *")
	}
	ro, _ := New(Options{WorkDir: root, ReadOnly: true})
	if _, err := ro.ResolvePath("x", true); err == nil {
		t.Fatal("read-only refuses writes")
	}
	if _, err := New(Options{WorkDir: filepath.Join(root, "missing")}); err == nil {
		t.Fatal("a missing work directory is an error")
	}
}
