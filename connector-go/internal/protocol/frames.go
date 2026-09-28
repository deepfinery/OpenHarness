// Package protocol implements the device side of the OpenHarness device gateway wire protocol (docs/PROTOCOL.md):
// an outbound WebSocket, a `hello`/`welcome` handshake, heartbeats, resume and reconnect with backoff. Everything
// after the handshake is one JSON-RPC message per text frame, handed to a Handler.
package protocol

import (
	"encoding/json"
	"errors"
	"regexp"
	"time"
)

const (
	// ProtocolVersion is the device gateway protocol version this client speaks.
	ProtocolVersion = 1
	// Subprotocol is the WebSocket subprotocol the gateway requires.
	Subprotocol = "openharness-mcp.v1"
	// MaxFrameBytes is the largest text frame either side may send.
	MaxFrameBytes = 4 << 20
	// HandshakeTimeout bounds the wait for `welcome` after the socket opens.
	HandshakeTimeout = 10 * time.Second
	// DefaultHeartbeat is used when the gateway does not say otherwise.
	DefaultHeartbeat = 30 * time.Second
)

// Close codes with protocol meaning.
const (
	CloseGoingAway          = 1001
	CloseUnauthenticated    = 4001
	CloseForbidden          = 4003
	CloseProtocolError      = 4008
	CloseSuperseded         = 4009
	CloseUnsupportedVersion = 4013
	CloseRateLimited        = 4029
)

// DeviceIDPattern is the identifier the gateway accepts.
var DeviceIDPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,62}$`)

// ErrFatal is returned by Run when the gateway refused the device permanently (disabled, platform mismatch or an
// unsupported protocol version). Retrying cannot help until an operator intervenes.
var ErrFatal = errors.New("gateway refused the device permanently")

// Identity is what the connector says about itself in `hello`.
type Identity struct {
	DeviceID         string   `json:"device_id"`
	Platform         string   `json:"platform"`
	Hostname         string   `json:"hostname"`
	ConnectorVersion string   `json:"connector_version"`
	Capabilities     []string `json:"capabilities"`
}

type resumeFrame struct {
	SessionID string `json:"session_id"`
}
type helloFrame struct {
	Type            string `json:"type"`
	ProtocolVersion int    `json:"protocol_version"`
	Identity
	Token  string       `json:"token"`
	Resume *resumeFrame `json:"resume,omitempty"`
}
type welcomeFrame struct {
	Type             string `json:"type"`
	SessionID        string `json:"session_id"`
	HeartbeatSeconds int    `json:"heartbeat_seconds"`
	Resumed          bool   `json:"resumed"`
	ServerTime       string `json:"server_time"`
}

// frameKind classifies one inbound text frame: a control frame carries `type`, anything else must be JSON-RPC.
func frameKind(raw []byte) (kind string, err error) {
	var probe struct {
		Type    *string          `json:"type"`
		JSONRPC *string          `json:"jsonrpc"`
		Method  *string          `json:"method"`
		ID      *json.RawMessage `json:"id"`
		Result  *json.RawMessage `json:"result"`
		Error   *json.RawMessage `json:"error"`
	}
	if err := json.Unmarshal(raw, &probe); err != nil {
		return "", errors.New("frame is not a JSON object")
	}
	if probe.Type != nil {
		return *probe.Type, nil
	}
	if probe.JSONRPC == nil || (probe.Method == nil && probe.Result == nil && probe.Error == nil) {
		return "", errors.New("frame is neither a control frame nor a JSON-RPC message")
	}
	return "rpc", nil
}
