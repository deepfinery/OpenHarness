// openharness-connector: the Linux connector. It dials out to the OpenHarness device gateway over WebSocket and
// serves the Linux tools as an MCP server. The same binary is the executor inside an OpenShell sandbox.
package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/deepfinery/OpenHarness/connector-go/internal/audit"
	"github.com/deepfinery/OpenHarness/connector-go/internal/linuxtools"
	"github.com/deepfinery/OpenHarness/connector-go/internal/mcp"
	"github.com/deepfinery/OpenHarness/connector-go/internal/policy"
	"github.com/deepfinery/OpenHarness/connector-go/internal/protocol"
)

// version is stamped at build time.
var version = "0.2.0"

const usage = `openharness-connector %s
Connects a Linux machine, container or OpenShell sandbox to the OpenHarness device gateway.

  --print-config   show the effective configuration (token redacted) and exit
  --version        print the version and exit

Environment:
  GATEWAY_URL               wss://<gateway>/connect (ws:// only with GATEWAY_ALLOW_INSECURE=true)
  GATEWAY_CA_FILE | GATEWAY_CA_PEM | GATEWAY_CA_PEM_BASE64   a certificate authority to trust for the gateway
  DEVICE_ID                 machine id issued by the studio
  DEVICE_TOKEN | DEVICE_TOKEN_FILE   the one-time enrollment token, or a file holding it
  DEVICE_PLATFORM           linux (default)
  DEVICE_HOSTNAME           reported host name (default: the system host name)
  WORK_DIR                  directory the file tools may use (default: /work, else the current directory)
  ALLOW_COMMANDS            comma-separated programs run_command may run; "*" allows any
  DENY_COMMANDS             comma-separated programs always refused
  READ_ONLY                 true disables writes
  MAX_OUTPUT_BYTES          output cap per call (default 200000)
  COMMAND_TIMEOUT_SECONDS   per-command deadline (default 60)
  AUDIT_FILE                JSON-lines audit log (default: stderr)
  LOG_LEVEL                 debug|info|warn|error
  OPENHARNESS_SANDBOXED     true when running inside an OpenShell sandbox (set by the edge)
`

type config struct {
	GatewayURL     string   `json:"gateway_url"`
	DeviceID       string   `json:"device_id"`
	Platform       string   `json:"platform"`
	Hostname       string   `json:"hostname"`
	Token          string   `json:"token"`
	AllowInsecure  bool     `json:"allow_insecure"`
	CAFile         string   `json:"ca_file,omitempty"`
	CAPEM          string   `json:"ca_pem,omitempty"`
	WorkDir        string   `json:"work_dir"`
	AllowCommands  []string `json:"allow_commands"`
	DenyCommands   []string `json:"deny_commands"`
	ReadOnly       bool     `json:"read_only"`
	MaxOutputBytes int      `json:"max_output_bytes"`
	CommandTimeout int      `json:"command_timeout_seconds"`
	AuditFile      string   `json:"audit_file"`
	LogLevel       string   `json:"log_level"`
	Sandboxed      bool     `json:"sandboxed"`
}

func list(value string) []string {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	var out []string
	for _, part := range strings.Split(value, ",") {
		if p := strings.TrimSpace(part); p != "" {
			out = append(out, p)
		}
	}
	return out
}
func boolean(value string) bool {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "1", "true", "yes", "on":
		return true
	}
	return false
}
func number(value string, fallback int) int {
	if v, err := strconv.Atoi(strings.TrimSpace(value)); err == nil {
		return v
	}
	return fallback
}

func loadConfig() (*config, []string, error) {
	var warnings []string
	c := &config{
		GatewayURL:     os.Getenv("GATEWAY_URL"),
		DeviceID:       os.Getenv("DEVICE_ID"),
		Platform:       os.Getenv("DEVICE_PLATFORM"),
		Hostname:       os.Getenv("DEVICE_HOSTNAME"),
		Token:          os.Getenv("DEVICE_TOKEN"),
		AllowInsecure:  boolean(os.Getenv("GATEWAY_ALLOW_INSECURE")),
		CAFile:         os.Getenv("GATEWAY_CA_FILE"),
		CAPEM:          os.Getenv("GATEWAY_CA_PEM"),
		WorkDir:        os.Getenv("WORK_DIR"),
		AllowCommands:  list(os.Getenv("ALLOW_COMMANDS")),
		DenyCommands:   list(os.Getenv("DENY_COMMANDS")),
		ReadOnly:       boolean(os.Getenv("READ_ONLY")),
		MaxOutputBytes: number(os.Getenv("MAX_OUTPUT_BYTES"), 200_000),
		CommandTimeout: number(os.Getenv("COMMAND_TIMEOUT_SECONDS"), 60),
		AuditFile:      os.Getenv("AUDIT_FILE"),
		LogLevel:       os.Getenv("LOG_LEVEL"),
		Sandboxed:      boolean(os.Getenv("OPENHARNESS_SANDBOXED")),
	}
	if c.Platform == "" {
		c.Platform = "linux"
	}
	if c.Hostname == "" {
		c.Hostname, _ = os.Hostname()
	}
	// Sandbox environments cannot carry newlines, so the CA may also arrive base64-encoded.
	if encoded := strings.TrimSpace(os.Getenv("GATEWAY_CA_PEM_BASE64")); encoded != "" && c.CAPEM == "" {
		decoded, err := base64.StdEncoding.DecodeString(encoded)
		if err != nil {
			return nil, nil, fmt.Errorf("GATEWAY_CA_PEM_BASE64 is not valid base64: %w", err)
		}
		c.CAPEM = string(decoded)
	}
	if c.Token == "" {
		if file := os.Getenv("DEVICE_TOKEN_FILE"); file != "" {
			data, err := os.ReadFile(file)
			if err != nil {
				return nil, nil, fmt.Errorf("cannot read DEVICE_TOKEN_FILE: %w", err)
			}
			if info, err := os.Stat(file); err == nil && info.Mode().Perm()&0o077 != 0 {
				warnings = append(warnings, fmt.Sprintf("token file %s is readable by other users; chmod 600 it", file))
			}
			c.Token = strings.TrimSpace(string(data))
		}
	}
	if c.Token == "" {
		return nil, nil, errors.New("no device token: set DEVICE_TOKEN or DEVICE_TOKEN_FILE")
	}
	if c.GatewayURL == "" || c.DeviceID == "" {
		return nil, nil, errors.New("GATEWAY_URL and DEVICE_ID are required")
	}
	if c.WorkDir == "" {
		if _, err := os.Stat("/work"); err == nil {
			c.WorkDir = "/work"
		} else {
			c.WorkDir, _ = os.Getwd()
		}
	}
	if c.DenyCommands == nil {
		c.DenyCommands = policy.DefaultDenyCommands
	}
	if c.MaxOutputBytes < 1024 {
		c.MaxOutputBytes = 1024
	}
	if c.CommandTimeout < 1 {
		c.CommandTimeout = 1
	}
	return c, warnings, nil
}

func logger(level string) *slog.Logger {
	var l slog.Level
	switch strings.ToLower(level) {
	case "debug":
		l = slog.LevelDebug
	case "warn":
		l = slog.LevelWarn
	case "error":
		l = slog.LevelError
	default:
		l = slog.LevelInfo
	}
	return slog.New(slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{Level: l}))
}

func main() {
	for _, arg := range os.Args[1:] {
		switch arg {
		case "--version":
			fmt.Println("openharness-connector " + version)
			return
		case "-h", "--help":
			fmt.Printf(usage, version)
			return
		}
	}
	cfg, warnings, err := loadConfig()
	if err != nil {
		fmt.Fprintln(os.Stderr, `{"level":"error","msg":`+strconv.Quote(err.Error())+`}`)
		os.Exit(1)
	}
	log := logger(cfg.LogLevel).With("component", "connector", "device_id", cfg.DeviceID)
	for _, w := range warnings {
		log.Warn(w)
	}
	for _, arg := range os.Args[1:] {
		if arg == "--print-config" {
			redacted := *cfg
			redacted.Token = "[redacted]"
			if redacted.CAPEM != "" {
				redacted.CAPEM = "[pem]"
			}
			out, _ := json.MarshalIndent(redacted, "", "  ")
			fmt.Println(string(out))
			return
		}
	}
	pol, err := policy.New(policy.Options{
		WorkDir:        cfg.WorkDir,
		AllowCommands:  cfg.AllowCommands,
		DenyCommands:   cfg.DenyCommands,
		MaxOutputBytes: cfg.MaxOutputBytes,
		CommandTimeout: time.Duration(cfg.CommandTimeout) * time.Second,
		ReadOnly:       cfg.ReadOnly,
	})
	if err != nil {
		log.Error("invalid policy", "error", err.Error())
		os.Exit(1)
	}
	auditLog, err := audit.Open(cfg.AuditFile)
	if err != nil {
		log.Error("cannot open audit file", "error", err.Error())
		os.Exit(1)
	}
	defer auditLog.Close()
	server := mcp.NewServer("openharness-connector", version)
	linuxtools.Register(server, &linuxtools.Context{Policy: pol, Audit: auditLog, Hostname: cfg.Hostname, Sandboxed: cfg.Sandboxed, Version: version})
	capabilities := server.ToolNames()
	if cfg.Sandboxed {
		capabilities = append(capabilities, "openshell_sandbox")
	}
	client, err := protocol.New(protocol.Options{
		URL:           cfg.GatewayURL,
		Token:         cfg.Token,
		AllowInsecure: cfg.AllowInsecure,
		CAFile:        cfg.CAFile,
		CAPEM:         cfg.CAPEM,
		Identity: protocol.Identity{
			DeviceID:         cfg.DeviceID,
			Platform:         cfg.Platform,
			Hostname:         cfg.Hostname,
			ConnectorVersion: version,
			Capabilities:     capabilities,
		},
		Logger: log,
		OnState: func(state string, code int, reason string, attempt int) {
			log.Info("gateway "+state, "code", code, "reason", reason, "attempt", attempt)
		},
	}, server)
	if err != nil {
		log.Error("invalid configuration", "error", err.Error())
		os.Exit(1)
	}
	log.Info("connector starting", "work_dir", pol.WorkDir, "read_only", cfg.ReadOnly, "allow_commands", cfg.AllowCommands, "sandboxed", cfg.Sandboxed, "tools", server.ToolNames())
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	if err := client.Run(ctx); err != nil {
		log.Error("connector stopped", "error", err.Error())
		os.Exit(2)
	}
	log.Info("connector stopped")
}
