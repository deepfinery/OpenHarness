// openharness-edge: runs beside an OpenShell gateway, exposes it to OpenHarness as MCP tools over an outbound
// WebSocket, and launches executors (sandboxes that run the OpenHarness connector under a policy).
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	v1 "github.com/NVIDIA/OpenShell/sdk/go/openshell/v1"
	"github.com/deepfinery/OpenHarness/connector-go/internal/audit"
	"github.com/deepfinery/OpenHarness/connector-go/internal/edge"
	"github.com/deepfinery/OpenHarness/connector-go/internal/mcp"
	"github.com/deepfinery/OpenHarness/connector-go/internal/protocol"
)

var version = "0.2.0"

const usage = `openharness-edge %s
Exposes an OpenShell gateway to OpenHarness and launches confined executors.

  --version   print the version and exit

Harness side:
  GATEWAY_URL, DEVICE_ID, DEVICE_TOKEN | DEVICE_TOKEN_FILE, GATEWAY_ALLOW_INSECURE, GATEWAY_CA_FILE | GATEWAY_CA_PEM,
  DEVICE_HOSTNAME, AUDIT_FILE, LOG_LEVEL
OpenShell side:
  OPENSHELL_ADDRESS (host:port, default openshell-gateway:8080)   OPENSHELL_TLS (true|false)
  OPENSHELL_TLS_CA, OPENSHELL_TLS_CERT, OPENSHELL_TLS_KEY, OPENSHELL_TLS_INSECURE   OPENSHELL_TOKEN (bearer)
  OPENSHELL_FAKE=true uses an in-memory OpenShell (tests only)
Edge settings:
  OPENSHELL_WORKSPACE, OPENSHELL_WORKSPACES, OPENSHELL_ALLOW_POLICY_CHANGES, OPENSHELL_ALLOW_SANDBOX_LIFECYCLE,
  OPENSHELL_ALLOW_EXEC, OPENSHELL_ALLOWED_IMAGES, OPENSHELL_MAX_SANDBOXES, OPENSHELL_MANAGE_ALL_SANDBOXES
Executors:
  EXECUTOR_IMAGE (default openharness-connector:local)   EXECUTOR_ALLOWED_HOSTS (host:port,...)
  EXECUTOR_GATEWAY_URL (default GATEWAY_URL)   EXECUTOR_DEVICE_ID + EXECUTOR_TOKEN launch one executor at start
`

func env(key, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return fallback
}
func boolean(key string, fallback bool) bool {
	v := strings.ToLower(strings.TrimSpace(os.Getenv(key)))
	if v == "" {
		return fallback
	}
	return v == "1" || v == "true" || v == "yes" || v == "on"
}
func list(key string) []string {
	var out []string
	for _, part := range strings.Split(os.Getenv(key), ",") {
		if p := strings.TrimSpace(part); p != "" {
			out = append(out, p)
		}
	}
	return out
}

func logger() *slog.Logger {
	var l slog.Level
	switch strings.ToLower(os.Getenv("LOG_LEVEL")) {
	case "debug":
		l = slog.LevelDebug
	case "warn":
		l = slog.LevelWarn
	case "error":
		l = slog.LevelError
	default:
		l = slog.LevelInfo
	}
	return slog.New(slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{Level: l})).With("component", "edge")
}

func fail(log *slog.Logger, msg string, err error) {
	log.Error(msg, "error", err.Error())
	os.Exit(1)
}

func main() {
	for _, arg := range os.Args[1:] {
		switch arg {
		case "--version":
			fmt.Println("openharness-edge " + version)
			return
		case "-h", "--help":
			fmt.Printf(usage, version)
			return
		}
	}
	log := logger()
	token := os.Getenv("DEVICE_TOKEN")
	if token == "" {
		if file := os.Getenv("DEVICE_TOKEN_FILE"); file != "" {
			data, err := os.ReadFile(file)
			if err != nil {
				fail(log, "cannot read DEVICE_TOKEN_FILE", err)
			}
			token = strings.TrimSpace(string(data))
		}
	}
	gatewayURL, deviceID := os.Getenv("GATEWAY_URL"), os.Getenv("DEVICE_ID")
	if gatewayURL == "" || deviceID == "" || token == "" {
		fail(log, "configuration", errors.New("GATEWAY_URL, DEVICE_ID and DEVICE_TOKEN (or DEVICE_TOKEN_FILE) are required"))
	}
	caFile, caPEM := os.Getenv("GATEWAY_CA_FILE"), os.Getenv("GATEWAY_CA_PEM")
	if caFile != "" && caPEM == "" {
		data, err := os.ReadFile(caFile)
		if err != nil {
			fail(log, "cannot read GATEWAY_CA_FILE", fmt.Errorf("%w (the path is read inside the edge container, where deploy/openshell/certs is mounted as /certs: put the certificate in ./certs and set OPENHARNESS_CA_FILE=/certs/<file>)", err))
		}
		caPEM = string(data)
	}
	settings := edge.DefaultSettings()
	settings.DeviceID = deviceID
	settings.Version = version
	settings.Workspace = env("OPENSHELL_WORKSPACE", "default")
	settings.Workspaces = list("OPENSHELL_WORKSPACES")
	settings.AllowPolicyChanges = boolean("OPENSHELL_ALLOW_POLICY_CHANGES", true)
	settings.AllowSandboxLifecycle = boolean("OPENSHELL_ALLOW_SANDBOX_LIFECYCLE", true)
	settings.AllowExec = boolean("OPENSHELL_ALLOW_EXEC", true)
	settings.AllowedImages = list("OPENSHELL_ALLOWED_IMAGES")
	if n, err := strconv.Atoi(env("OPENSHELL_MAX_SANDBOXES", "20")); err == nil && n >= 0 {
		settings.MaxSandboxes = n
	}
	settings.ManageAllSandboxes = boolean("OPENSHELL_MANAGE_ALL_SANDBOXES", true)
	settings.ExecutorImage = env("EXECUTOR_IMAGE", "openharness-connector:local")
	settings.ExecutorAllowedHosts = list("EXECUTOR_ALLOWED_HOSTS")
	settings.ExecutorGatewayURL = env("EXECUTOR_GATEWAY_URL", gatewayURL)
	settings.ExecutorGatewayCAPEM = caPEM

	var backend edge.Backend
	if boolean("OPENSHELL_FAKE", false) {
		log.Warn("using the in-memory OpenShell stand-in; no sandbox is confined")
		backend = edge.NewMemBackend()
	} else {
		// The SDK speaks plaintext only for http:// addresses and TLS otherwise, so the scheme carries the choice.
		address := env("OPENSHELL_ADDRESS", "openshell-gateway:8080")
		useTLS := boolean("OPENSHELL_TLS", false) || os.Getenv("OPENSHELL_TLS_CA") != "" || os.Getenv("OPENSHELL_TLS_CERT") != ""
		if !strings.Contains(address, "://") {
			if useTLS {
				address = "https://" + address
			} else {
				address = "http://" + address
			}
		}
		cfg := v1.Config{Address: address, Timeout: 2 * time.Minute}
		if t := os.Getenv("OPENSHELL_TOKEN"); t != "" {
			cfg.Auth = v1.StaticToken(t)
		} else {
			cfg.Auth = v1.NoAuth()
		}
		if useTLS {
			cfg.TLS = &v1.TLSConfig{CAFile: os.Getenv("OPENSHELL_TLS_CA"), CertFile: os.Getenv("OPENSHELL_TLS_CERT"), KeyFile: os.Getenv("OPENSHELL_TLS_KEY"), Insecure: boolean("OPENSHELL_TLS_INSECURE", false)}
		}
		client, err := v1.NewClient(cfg)
		if err != nil {
			fail(log, "cannot connect to the OpenShell gateway", err)
		}
		defer client.Close()
		backend = edge.NewSDKBackend(client)
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	// Preflight: the OpenShell gateway must answer; the edge keeps retrying so compose ordering does not matter.
	for attempt := 1; ; attempt++ {
		checkCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
		status, err := backend.Status(checkCtx)
		cancel()
		if err == nil {
			log.Info("openshell gateway reachable", "version", status.Version, "healthy", status.Healthy)
			break
		}
		if ctx.Err() != nil {
			return
		}
		log.Warn("openshell gateway not reachable yet", "error", err.Error(), "attempt", attempt)
		select {
		case <-ctx.Done():
			return
		case <-time.After(time.Duration(min(attempt, 6)) * 5 * time.Second):
		}
	}
	auditLog, err := audit.Open(os.Getenv("AUDIT_FILE"))
	if err != nil {
		fail(log, "cannot open the audit file", err)
	}
	defer auditLog.Close()
	registrar := &edge.Registrar{Backend: backend, Settings: settings, Audit: auditLog}
	server := mcp.NewServer("openharness-edge", version)
	registrar.Register(server)

	if execID, execToken := os.Getenv("EXECUTOR_DEVICE_ID"), os.Getenv("EXECUTOR_TOKEN"); execID != "" && execToken != "" {
		go func() {
			if _, err := backend.GetSandbox(ctx, settings.Workspace, execID); err == nil {
				log.Info("bootstrap executor already exists", "sandbox", execID)
				return
			}
			log.Info("launching the bootstrap executor", "sandbox", execID)
			if _, _, err := edge.LaunchExecutor(ctx, backend, settings, edge.ExecutorRequest{Name: execID, DeviceID: execID, Token: execToken, GatewayURL: settings.ExecutorGatewayURL, Workspace: settings.Workspace}); err != nil {
				log.Error("bootstrap executor failed", "error", err.Error())
				return
			}
			log.Info("bootstrap executor ready", "sandbox", execID)
		}()
	}
	hostname := env("DEVICE_HOSTNAME", "")
	if hostname == "" {
		hostname, _ = os.Hostname()
	}
	client, err := protocol.New(protocol.Options{
		URL: gatewayURL, Token: token, AllowInsecure: boolean("GATEWAY_ALLOW_INSECURE", false), CAPEM: caPEM,
		Identity: protocol.Identity{DeviceID: deviceID, Platform: "openshell", Hostname: hostname, ConnectorVersion: version, Capabilities: server.ToolNames()},
		Logger:   log,
		OnState: func(state string, code int, reason string, attempt int) {
			log.Info("gateway "+state, "code", code, "reason", reason, "attempt", attempt)
		},
	}, server)
	if err != nil {
		fail(log, "invalid configuration", err)
	}
	log.Info("edge starting", "device_id", deviceID, "workspace", settings.Workspace, "executor_image", settings.ExecutorImage, "tools", server.ToolNames())
	if err := client.Run(ctx); err != nil {
		fail(log, "edge stopped", err)
	}
	log.Info("edge stopped")
}
