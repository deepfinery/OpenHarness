package protocol

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"math/rand/v2"
	"net/http"
	"net/url"
	"os"
	"sync"
	"time"

	"github.com/coder/websocket"
)

// Writer sends one JSON-RPC message back to the gateway on the current connection.
type Writer interface {
	Write(ctx context.Context, message []byte) error
}

// Handler receives every JSON-RPC frame after `welcome`. Calls run concurrently; ctx ends when the connection
// that carried the frame closes, so long tool calls stop when the gateway is gone.
type Handler interface {
	HandleFrame(ctx context.Context, message json.RawMessage, w Writer)
}

// Options configure the client. URL must be wss:// (or ws:// with AllowInsecure) and carry no credentials.
type Options struct {
	URL           string
	Token         string
	Identity      Identity
	AllowInsecure bool
	// CAFile and CAPEM add a certificate authority to trust for wss://, for gateways behind a self-signed or
	// private certificate. Either may be empty; the system roots stay trusted too.
	CAFile string
	CAPEM  string
	// Heartbeat overrides the interval the gateway announces (tests); zero uses the gateway's value.
	Heartbeat time.Duration
	// MaxBackoff caps the reconnect delay; zero means 60 seconds.
	MaxBackoff time.Duration
	Logger     *slog.Logger
	// OnState is told about connecting, connected, disconnected and stopped transitions.
	OnState func(state string, code int, reason string, attempt int)
	// Random returns [0,1); tests pin it. Nil uses math/rand.
	Random func() float64
}

// Client keeps a device connected to the gateway for the lifetime of Run.
type Client struct {
	opts      Options
	handler   Handler
	log       *slog.Logger
	mu        sync.Mutex
	sessionID string
	attempt   int
	conn      *websocket.Conn
	http      *http.Client
}

// New validates the options and prepares a client; nothing is dialled until Run.
func New(opts Options, handler Handler) (*Client, error) {
	u, err := url.Parse(opts.URL)
	if err != nil {
		return nil, fmt.Errorf("gateway URL: %w", err)
	}
	if u.Scheme != "wss" && !(u.Scheme == "ws" && opts.AllowInsecure) {
		return nil, errors.New("the gateway URL must use wss:// (set GATEWAY_ALLOW_INSECURE=true for ws:// in development)")
	}
	if u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return nil, errors.New("credentials never travel in the gateway URL")
	}
	if len(opts.Token) < 16 || len(opts.Token) > 512 {
		return nil, errors.New("the device token must be between 16 and 512 characters")
	}
	if !DeviceIDPattern.MatchString(opts.Identity.DeviceID) {
		return nil, fmt.Errorf("invalid device id %q", opts.Identity.DeviceID)
	}
	if opts.Identity.Platform == "" {
		return nil, errors.New("a platform is required")
	}
	if opts.Logger == nil {
		opts.Logger = slog.Default()
	}
	if opts.MaxBackoff == 0 {
		opts.MaxBackoff = 60 * time.Second
	}
	if opts.Random == nil {
		opts.Random = rand.Float64
	}
	httpClient, err := httpClientFor(opts)
	if err != nil {
		return nil, err
	}
	return &Client{opts: opts, handler: handler, log: opts.Logger, http: httpClient}, nil
}

// httpClientFor builds the dialer's HTTP client, adding the configured certificate authority when present.
func httpClientFor(opts Options) (*http.Client, error) {
	if opts.CAFile == "" && opts.CAPEM == "" {
		return http.DefaultClient, nil
	}
	pool, err := x509.SystemCertPool()
	if err != nil || pool == nil {
		pool = x509.NewCertPool()
	}
	pem := []byte(opts.CAPEM)
	if opts.CAFile != "" {
		data, err := os.ReadFile(opts.CAFile)
		if err != nil {
			return nil, fmt.Errorf("cannot read the gateway CA file (the path is read inside the connector's container; mount the certificate, for example -v \"$PWD/ca.crt:/certs/ca.crt:ro\" with GATEWAY_CA_FILE=/certs/ca.crt): %w", err)
		}
		pem = append(pem, '\n')
		pem = append(pem, data...)
	}
	if !pool.AppendCertsFromPEM(pem) {
		return nil, errors.New("the gateway CA does not contain a PEM certificate")
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.TLSClientConfig = &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}
	return &http.Client{Transport: transport}, nil
}

// SessionID is the session the gateway last issued; it is offered again on reconnect.
func (c *Client) SessionID() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.sessionID
}

// Run connects, serves and reconnects until ctx ends (returns nil) or the gateway refuses the device permanently
// (returns ErrFatal).
func (c *Client) Run(ctx context.Context) error {
	for {
		c.state("connecting", 0, "", c.attempt)
		started := time.Now()
		code, reason, err := c.serveOnce(ctx)
		if ctx.Err() != nil {
			c.state("stopped", code, reason, c.attempt)
			return nil
		}
		c.state("disconnected", code, reason, c.attempt)
		if err != nil {
			c.log.Warn("gateway connection ended", "code", code, "reason", reason, "error", err.Error())
		} else {
			c.log.Info("gateway connection ended", "code", code, "reason", reason)
		}
		switch code {
		case CloseForbidden, CloseUnsupportedVersion:
			c.state("stopped", code, reason, c.attempt)
			return fmt.Errorf("%w (close code %d)", ErrFatal, code)
		case CloseUnauthenticated:
			// A wrong or not-yet-enrolled token: keep trying, slowly, so enrollment can complete later.
			if c.attempt < 6 {
				c.attempt = 6
			}
		}
		if time.Since(started) >= 60*time.Second {
			c.attempt = 0
		}
		delay := c.backoff()
		c.attempt++
		c.log.Info("reconnecting to gateway", "in_ms", delay.Milliseconds(), "attempt", c.attempt)
		select {
		case <-ctx.Done():
			c.state("stopped", 0, "", c.attempt)
			return nil
		case <-time.After(delay):
		}
	}
}

func (c *Client) state(state string, code int, reason string, attempt int) {
	if c.opts.OnState != nil {
		c.opts.OnState(state, code, reason, attempt)
	}
}
func (c *Client) backoff() time.Duration {
	max := float64(c.opts.MaxBackoff)
	delay := math.Min(max, float64(time.Second)*math.Pow(2, float64(c.attempt)))
	return time.Duration(c.opts.Random() * delay)
}

type connWriter struct {
	conn *websocket.Conn
}

func (w *connWriter) Write(ctx context.Context, message []byte) error {
	if len(message) > MaxFrameBytes {
		return fmt.Errorf("frame of %d bytes exceeds the %d byte limit", len(message), MaxFrameBytes)
	}
	return w.conn.Write(ctx, websocket.MessageText, message)
}

// serveOnce runs one connection to completion and reports how it ended.
func (c *Client) serveOnce(ctx context.Context) (code int, reason string, err error) {
	dialCtx, cancelDial := context.WithTimeout(ctx, HandshakeTimeout)
	defer cancelDial()
	conn, _, err := websocket.Dial(dialCtx, c.opts.URL, &websocket.DialOptions{Subprotocols: []string{Subprotocol}, HTTPClient: c.http})
	if err != nil {
		return 1006, "connection failed", err
	}
	conn.SetReadLimit(MaxFrameBytes)
	connCtx, cancelConn := context.WithCancel(ctx)
	defer cancelConn()
	defer conn.CloseNow()
	c.mu.Lock()
	c.conn = conn
	hello := helloFrame{Type: "hello", ProtocolVersion: ProtocolVersion, Identity: c.opts.Identity, Token: c.opts.Token}
	if c.sessionID != "" {
		hello.Resume = &resumeFrame{SessionID: c.sessionID}
	}
	c.mu.Unlock()
	if hello.Capabilities == nil {
		hello.Capabilities = []string{}
	}
	payload, _ := json.Marshal(hello)
	if err := conn.Write(connCtx, websocket.MessageText, payload); err != nil {
		return closeStatus(err), "hello failed", err
	}
	// Handshake: the first frame must be `welcome`, within the handshake timeout.
	handshakeCtx, cancelHandshake := context.WithTimeout(connCtx, HandshakeTimeout)
	kind, raw, err := c.read(handshakeCtx, conn)
	cancelHandshake()
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) && ctx.Err() == nil {
			conn.Close(CloseProtocolError, "handshake timeout")
			return CloseProtocolError, "handshake timeout", errors.New("gateway handshake timed out")
		}
		return closeStatus(err), "closed during handshake", err
	}
	if kind != "welcome" {
		conn.Close(CloseProtocolError, "message before welcome")
		return CloseProtocolError, "message before welcome", fmt.Errorf("expected welcome, got %s", kind)
	}
	var welcome welcomeFrame
	if err := json.Unmarshal(raw, &welcome); err != nil || welcome.SessionID == "" {
		conn.Close(CloseProtocolError, "bad welcome")
		return CloseProtocolError, "bad welcome", errors.New("invalid welcome frame")
	}
	c.mu.Lock()
	c.sessionID = welcome.SessionID
	c.mu.Unlock()
	interval := c.opts.Heartbeat
	if interval == 0 {
		interval = time.Duration(welcome.HeartbeatSeconds) * time.Second
	}
	if interval <= 0 {
		interval = DefaultHeartbeat
	}
	c.log.Info("connected to gateway", "session_id", welcome.SessionID, "resumed", welcome.Resumed)
	c.state("connected", 0, "", c.attempt)

	writer := &connWriter{conn: conn}
	var lastInbound = time.Now()
	var inboundMu sync.Mutex
	touch := func() {
		inboundMu.Lock()
		lastInbound = time.Now()
		inboundMu.Unlock()
	}
	// Heartbeats keep intermediaries and the gateway's liveness happy; silence twice the interval means the
	// connection is dead even if the socket has not noticed.
	heartbeatDone := make(chan struct{})
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-connCtx.Done():
				return
			case <-ticker.C:
				inboundMu.Lock()
				silent := time.Since(lastInbound)
				inboundMu.Unlock()
				if silent > 2*interval {
					c.log.Warn("no traffic from gateway; reconnecting")
					conn.Close(CloseGoingAway, "liveness")
					close(heartbeatDone)
					return
				}
				_ = conn.Write(connCtx, websocket.MessageText, []byte(`{"type":"heartbeat"}`))
			}
		}
	}()
	for {
		kind, raw, err := c.read(connCtx, conn)
		if err != nil {
			select {
			case <-heartbeatDone:
				return CloseGoingAway, "liveness", nil
			default:
			}
			return closeStatus(err), closeReason(err), errIfNotClose(err)
		}
		touch()
		switch kind {
		case "heartbeat_ack", "heartbeat":
			continue
		case "rpc":
			go c.handler.HandleFrame(connCtx, raw, writer)
		case "welcome":
			continue
		default:
			conn.Close(CloseProtocolError, "unexpected frame")
			return CloseProtocolError, "unexpected frame", fmt.Errorf("unexpected %s frame after welcome", kind)
		}
	}
}

func (c *Client) read(ctx context.Context, conn *websocket.Conn) (string, json.RawMessage, error) {
	typ, raw, err := conn.Read(ctx)
	if err != nil {
		return "", nil, err
	}
	if typ != websocket.MessageText {
		conn.Close(CloseProtocolError, "binary frame")
		return "", nil, errors.New("binary frames are not allowed")
	}
	kind, err := frameKind(raw)
	if err != nil {
		conn.Close(CloseProtocolError, "bad frame")
		return "", nil, err
	}
	return kind, json.RawMessage(raw), nil
}

func closeStatus(err error) int {
	if s := websocket.CloseStatus(err); s != -1 {
		return int(s)
	}
	return 1006
}
func closeReason(err error) string {
	var ce websocket.CloseError
	if errors.As(err, &ce) {
		return ce.Reason
	}
	return "socket closed"
}
func errIfNotClose(err error) error {
	var ce websocket.CloseError
	if errors.As(err, &ce) {
		return nil
	}
	return err
}
