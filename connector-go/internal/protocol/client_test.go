package protocol

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// fakeGateway speaks the server side of docs/PROTOCOL.md: it checks hello, answers welcome, sends initialize and
// tools/list like the real hub, pings, and can drop or refuse connections on demand.
type fakeGateway struct {
	t        *testing.T
	server   *httptest.Server
	mu       sync.Mutex
	hellos   []map[string]any
	sessions int
	refuse   int // close code to refuse the next hello with; 0 accepts
	replies  chan json.RawMessage
	conns    []*websocket.Conn
}

func newFakeGateway(t *testing.T) *fakeGateway {
	g := &fakeGateway{t: t, replies: make(chan json.RawMessage, 64)}
	g.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{Subprotocols: []string{Subprotocol}})
		if err != nil {
			return
		}
		if conn.Subprotocol() != Subprotocol {
			conn.Close(4008, "subprotocol")
			return
		}
		ctx := r.Context()
		_, raw, err := conn.Read(ctx)
		if err != nil {
			return
		}
		var hello map[string]any
		_ = json.Unmarshal(raw, &hello)
		g.mu.Lock()
		g.hellos = append(g.hellos, hello)
		refuse := g.refuse
		g.refuse = 0
		g.sessions++
		session := g.sessions
		g.conns = append(g.conns, conn)
		g.mu.Unlock()
		if refuse != 0 {
			conn.Close(websocket.StatusCode(refuse), "refused")
			return
		}
		resumed := false
		if r, ok := hello["resume"].(map[string]any); ok && r["session_id"] == "sess-1" {
			resumed = true
			session = 1
		}
		welcome, _ := json.Marshal(map[string]any{"type": "welcome", "session_id": "sess-" + itoa(session), "heartbeat_seconds": 1, "resumed": resumed, "server_time": time.Now().UTC().Format(time.RFC3339)})
		_ = conn.Write(ctx, websocket.MessageText, welcome)
		init, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 0, "method": "initialize", "params": map[string]any{"protocolVersion": "2025-06-18", "capabilities": map[string]any{}, "clientInfo": map[string]any{"name": "openharness-gateway", "version": "0.1.0"}}})
		_ = conn.Write(ctx, websocket.MessageText, init)
		for {
			typ, raw, err := conn.Read(ctx)
			if err != nil {
				return
			}
			if typ != websocket.MessageText {
				conn.Close(4008, "binary")
				return
			}
			if strings.Contains(string(raw), `"type":"heartbeat"`) {
				_ = conn.Write(ctx, websocket.MessageText, []byte(`{"type":"heartbeat_ack","server_time":"now"}`))
				continue
			}
			g.replies <- json.RawMessage(raw)
		}
	}))
	t.Cleanup(g.server.Close)
	return g
}
func itoa(i int) string            { return string(rune('0' + i)) }
func (g *fakeGateway) url() string { return "ws" + strings.TrimPrefix(g.server.URL, "http") }
func (g *fakeGateway) send(t *testing.T, index int, message string) {
	g.mu.Lock()
	conn := g.conns[index]
	g.mu.Unlock()
	if err := conn.Write(context.Background(), websocket.MessageText, []byte(message)); err != nil {
		t.Fatalf("send: %v", err)
	}
}
func (g *fakeGateway) drop(index int) {
	g.mu.Lock()
	conn := g.conns[index]
	g.mu.Unlock()
	conn.Close(4000, "test drop")
}
func (g *fakeGateway) reply(t *testing.T) map[string]any {
	select {
	case raw := <-g.replies:
		var m map[string]any
		_ = json.Unmarshal(raw, &m)
		return m
	case <-time.After(5 * time.Second):
		t.Fatal("no reply from the device in time")
		return nil
	}
}

// echoHandler answers initialize and echoes tools/call arguments, so the tests can see frames arrive and leave.
type echoHandler struct{ calls chan json.RawMessage }

func (h *echoHandler) HandleFrame(ctx context.Context, raw json.RawMessage, w Writer) {
	var req struct {
		ID     json.RawMessage `json:"id"`
		Method string          `json:"method"`
		Params json.RawMessage `json:"params"`
	}
	_ = json.Unmarshal(raw, &req)
	if req.Method == "" || req.ID == nil {
		return
	}
	if h.calls != nil {
		h.calls <- raw
	}
	result := map[string]any{"echo": req.Method}
	if req.Method == "slow" {
		select {
		case <-ctx.Done():
			result["cancelled"] = true
		case <-time.After(2 * time.Second):
		}
	}
	out, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": result})
	_ = w.Write(ctx, out)
}

func options(url string) Options {
	return Options{
		URL: url, Token: "dv_0123456789abcdef0123456789", AllowInsecure: true,
		Identity:   Identity{DeviceID: "test-box", Platform: "linux", Hostname: "unit", ConnectorVersion: "0.0.1", Capabilities: []string{"echo"}},
		MaxBackoff: 200 * time.Millisecond, Random: func() float64 { return 0.5 },
	}
}

func TestValidatesOptions(t *testing.T) {
	handler := &echoHandler{}
	for _, bad := range []Options{
		{URL: "ws://gateway/connect", Token: "0123456789abcdef", Identity: Identity{DeviceID: "a", Platform: "linux"}},
		{URL: "wss://user:pw@gateway/connect", Token: "0123456789abcdef", Identity: Identity{DeviceID: "a", Platform: "linux"}},
		{URL: "wss://gateway/connect?x=1", Token: "0123456789abcdef", Identity: Identity{DeviceID: "a", Platform: "linux"}},
		{URL: "wss://gateway/connect", Token: "short", Identity: Identity{DeviceID: "a", Platform: "linux"}},
		{URL: "wss://gateway/connect", Token: "0123456789abcdef", Identity: Identity{DeviceID: "Bad_ID", Platform: "linux"}},
	} {
		if _, err := New(bad, handler); err == nil {
			t.Errorf("expected %+v to be rejected", bad)
		}
	}
	if _, err := New(Options{URL: "wss://gateway/connect", Token: "0123456789abcdef", Identity: Identity{DeviceID: "ok-1", Platform: "linux"}}, handler); err != nil {
		t.Fatalf("valid options rejected: %v", err)
	}
}

func TestHandshakeFramesAndReconnectWithResume(t *testing.T) {
	gateway := newFakeGateway(t)
	handler := &echoHandler{calls: make(chan json.RawMessage, 16)}
	opts := options(gateway.url())
	states := make(chan string, 64)
	opts.OnState = func(state string, code int, reason string, attempt int) { states <- state }
	client, err := New(opts, handler)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- client.Run(ctx) }()

	// The first frame is hello with our identity and the protocol version; the gateway's initialize is answered.
	reply := gateway.reply(t)
	if reply["result"].(map[string]any)["echo"] != "initialize" {
		t.Fatalf("expected the initialize reply first, got %v", reply)
	}
	gateway.mu.Lock()
	hello := gateway.hellos[0]
	gateway.mu.Unlock()
	if hello["type"] != "hello" || hello["protocol_version"].(float64) != 1 || hello["device_id"] != "test-box" || hello["platform"] != "linux" || hello["token"] != opts.Token {
		t.Fatalf("bad hello: %v", hello)
	}
	if caps, _ := hello["capabilities"].([]any); len(caps) != 1 || caps[0] != "echo" {
		t.Fatalf("capabilities not sent: %v", hello["capabilities"])
	}
	if _, present := hello["resume"]; present {
		t.Fatal("a first connection must not try to resume")
	}
	if client.SessionID() != "sess-1" {
		t.Fatalf("session id not recorded: %q", client.SessionID())
	}
	// A tools/call round trip, then a heartbeat exchange happens on its own (interval 1 s).
	gateway.send(t, 0, `{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"x"}}`)
	if r := gateway.reply(t); r["id"].(float64) != 7 || r["result"].(map[string]any)["echo"] != "tools/call" {
		t.Fatalf("bad tools/call reply: %v", r)
	}
	// A slow call is cancelled when the socket drops, and the device reconnects offering its session id.
	gateway.send(t, 0, `{"jsonrpc":"2.0","id":8,"method":"slow"}`)
	<-handler.calls // initialize
	<-handler.calls // tools/call
	<-handler.calls // slow
	gateway.drop(0)
	deadline := time.After(5 * time.Second)
	for {
		gateway.mu.Lock()
		n := len(gateway.hellos)
		gateway.mu.Unlock()
		if n >= 2 {
			break
		}
		select {
		case <-deadline:
			t.Fatal("device did not reconnect")
		case <-time.After(20 * time.Millisecond):
		}
	}
	gateway.mu.Lock()
	second := gateway.hellos[1]
	gateway.mu.Unlock()
	if resume, ok := second["resume"].(map[string]any); !ok || resume["session_id"] != "sess-1" {
		t.Fatalf("reconnect did not offer the previous session: %v", second)
	}
	// The reconnected socket answers the new initialize.
	if r := gateway.reply(t); r["result"].(map[string]any)["echo"] != "initialize" {
		t.Fatalf("expected initialize on the resumed connection, got %v", r)
	}
	seen := map[string]bool{}
	timeout := time.After(2 * time.Second)
	for !(seen["connecting"] && seen["connected"] && seen["disconnected"]) {
		select {
		case s := <-states:
			seen[s] = true
		case <-timeout:
			t.Fatalf("state transitions incomplete: %v", seen)
		}
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatalf("Run returned %v after cancellation", err)
	}
}

func TestPermanentRefusalStopsAndUnauthenticatedBacksOff(t *testing.T) {
	gateway := newFakeGateway(t)
	gateway.refuse = CloseForbidden
	client, _ := New(options(gateway.url()), &echoHandler{})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := client.Run(ctx); err == nil || !strings.Contains(err.Error(), "permanently") {
		t.Fatalf("expected a fatal error on 4003, got %v", err)
	}
	// An unknown token keeps retrying with the maximum backoff instead of dying.
	gateway.refuse = CloseUnauthenticated
	client, _ = New(options(gateway.url()), &echoHandler{})
	ctx2, cancel2 := context.WithTimeout(context.Background(), 900*time.Millisecond)
	defer cancel2()
	if err := client.Run(ctx2); err != nil {
		t.Fatalf("4001 must not be fatal: %v", err)
	}
	gateway.mu.Lock()
	attempts := len(gateway.hellos)
	gateway.mu.Unlock()
	if attempts < 2 {
		t.Fatalf("expected the device to retry after 4001, saw %d attempts", attempts)
	}
}

func TestFrameKind(t *testing.T) {
	for raw, want := range map[string]string{
		`{"type":"welcome","session_id":"s"}`:          "welcome",
		`{"type":"heartbeat_ack"}`:                     "heartbeat_ack",
		`{"jsonrpc":"2.0","id":1,"method":"ping"}`:     "rpc",
		`{"jsonrpc":"2.0","method":"notifications/x"}`: "rpc",
		`{"jsonrpc":"2.0","id":1,"result":{}}`:         "rpc",
		`{"jsonrpc":"2.0","id":1,"error":{"code":-1}}`: "rpc",
	} {
		kind, err := frameKind([]byte(raw))
		if err != nil || kind != want {
			t.Errorf("%s: got %q %v, want %q", raw, kind, err, want)
		}
	}
	for _, bad := range []string{`[]`, `"x"`, `{"foo":1}`, `not json`} {
		if _, err := frameKind([]byte(bad)); err == nil {
			t.Errorf("%s should be rejected", bad)
		}
	}
}
