package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"
)

type memWriter struct{ out chan []byte }

func (w *memWriter) Write(_ context.Context, m []byte) error { w.out <- m; return nil }

func decode(t *testing.T, w *memWriter) map[string]any {
	select {
	case raw := <-w.out:
		var m map[string]any
		if err := json.Unmarshal(raw, &m); err != nil {
			t.Fatal(err)
		}
		return m
	case <-time.After(2 * time.Second):
		t.Fatal("no reply")
		return nil
	}
}

func TestLifecycleAndToolCalls(t *testing.T) {
	s := NewServer("unit", "1.0")
	s.AddTool(Tool{Name: "echo", Description: "echo", InputSchema: Object(map[string]any{"text": map[string]any{"type": "string"}}, "text"),
		Handler: func(_ context.Context, args json.RawMessage, meta Meta) (*Result, error) {
			var a struct{ Text string }
			_ = json.Unmarshal(args, &a)
			return Text(map[string]any{"text": a.Text, "key": meta.IdempotencyKey}), nil
		}})
	s.AddTool(Tool{Name: "fail", Description: "fails", InputSchema: Object(map[string]any{}), Handler: func(context.Context, json.RawMessage, Meta) (*Result, error) {
		return nil, errors.New("boom")
	}})
	s.AddTool(Tool{Name: "panic", Description: "panics", InputSchema: Object(map[string]any{}), Handler: func(context.Context, json.RawMessage, Meta) (*Result, error) {
		panic("kaboom")
	}})
	cancelled := make(chan bool, 1)
	s.AddTool(Tool{Name: "slow", Description: "slow", InputSchema: Object(map[string]any{}), Handler: func(ctx context.Context, _ json.RawMessage, _ Meta) (*Result, error) {
		select {
		case <-ctx.Done():
			cancelled <- true
			return Failure("cancelled"), nil
		case <-time.After(3 * time.Second):
			cancelled <- false
			return Text("late"), nil
		}
	}})
	w := &memWriter{out: make(chan []byte, 16)}
	ctx := context.Background()
	s.HandleFrame(ctx, json.RawMessage(`{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"gw","version":"1"}}}`), w)
	init := decode(t, w)
	result := init["result"].(map[string]any)
	if result["protocolVersion"] != "2025-03-26" || result["serverInfo"].(map[string]any)["name"] != "unit" {
		t.Fatalf("bad initialize result: %v", result)
	}
	if result["capabilities"].(map[string]any)["tools"].(map[string]any)["listChanged"] != true {
		t.Fatalf("tools capability missing: %v", result)
	}
	s.HandleFrame(ctx, json.RawMessage(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"1999-01-01"}}`), w)
	if decode(t, w)["result"].(map[string]any)["protocolVersion"] != "2025-06-18" {
		t.Fatal("unknown protocol versions fall back to the latest supported one")
	}
	s.HandleFrame(ctx, json.RawMessage(`{"jsonrpc":"2.0","method":"notifications/initialized"}`), w)
	s.HandleFrame(ctx, json.RawMessage(`{"jsonrpc":"2.0","id":2,"method":"ping"}`), w)
	if len(decode(t, w)["result"].(map[string]any)) != 0 {
		t.Fatal("ping answers with an empty object")
	}
	s.HandleFrame(ctx, json.RawMessage(`{"jsonrpc":"2.0","id":3,"method":"tools/list","params":{}}`), w)
	tools := decode(t, w)["result"].(map[string]any)["tools"].([]any)
	if len(tools) != 4 || tools[0].(map[string]any)["name"] != "echo" {
		t.Fatalf("tools/list: %v", tools)
	}
	if schema := tools[0].(map[string]any)["inputSchema"].(map[string]any); schema["type"] != "object" || schema["required"].([]any)[0] != "text" {
		t.Fatalf("schema not advertised: %v", schema)
	}
	s.HandleFrame(ctx, json.RawMessage(`{"jsonrpc":"2.0","id":"call-1","method":"tools/call","params":{"name":"echo","arguments":{"text":"hi"},"_meta":{"idempotencyKey":"run:1"}}}`), w)
	call := decode(t, w)
	if call["id"] != "call-1" {
		t.Fatalf("string ids are preserved: %v", call["id"])
	}
	structured := call["result"].(map[string]any)["structuredContent"].(map[string]any)
	if structured["text"] != "hi" || structured["key"] != "run:1" {
		t.Fatalf("arguments and _meta not delivered: %v", structured)
	}
	s.HandleFrame(ctx, json.RawMessage(`{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"fail"}}`), w)
	if r := decode(t, w)["result"].(map[string]any); r["isError"] != true || r["content"].([]any)[0].(map[string]any)["text"] != "boom" {
		t.Fatalf("handler errors become error results: %v", r)
	}
	s.HandleFrame(ctx, json.RawMessage(`{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"panic"}}`), w)
	if r := decode(t, w)["result"].(map[string]any); r["isError"] != true {
		t.Fatalf("panics become error results: %v", r)
	}
	s.HandleFrame(ctx, json.RawMessage(`{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"nope"}}`), w)
	if e := decode(t, w)["error"].(map[string]any); e["code"].(float64) != -32602 {
		t.Fatalf("unknown tools are a JSON-RPC error: %v", e)
	}
	s.HandleFrame(ctx, json.RawMessage(`{"jsonrpc":"2.0","id":8,"method":"resources/list"}`), w)
	if e := decode(t, w)["error"].(map[string]any); e["code"].(float64) != -32601 {
		t.Fatalf("unknown methods are -32601: %v", e)
	}
	// Cancellation notifications stop an in-flight call.
	go s.HandleFrame(ctx, json.RawMessage(`{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"slow"}}`), w)
	time.Sleep(50 * time.Millisecond)
	s.HandleFrame(ctx, json.RawMessage(`{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":9,"reason":"timeout"}}`), w)
	if !<-cancelled {
		t.Fatal("the slow call was not cancelled")
	}
	decode(t, w)
	// Responses to requests we never sent are ignored silently.
	s.HandleFrame(ctx, json.RawMessage(`{"jsonrpc":"2.0","id":99,"result":{}}`), w)
	select {
	case m := <-w.out:
		t.Fatalf("unexpected reply %s", m)
	case <-time.After(50 * time.Millisecond):
	}
}
