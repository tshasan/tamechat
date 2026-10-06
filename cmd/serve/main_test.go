package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"html-answers/spec"
)

// A stand-in OpenAI-compatible backend that records what it was sent.
func fakeBackend(t *testing.T, got *map[string]any, auth *string) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewDecoder(r.Body).Decode(got)
		*auth = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "text/event-stream")
		for _, c := range []string{
			`{"choices":[{"delta":{"reasoning_content":"hmm "}}]}`,
			`{"choices":[{"delta":{"content":"<p>Hel"}}]}`,
			`: keep-alive`,
			`{"choices":[{"delta":{"content":"lo</p>"}}]}`,
			`{"choices":[{"delta":{},"finish_reason":"stop"}]}`,
			`[DONE]`,
		} {
			if strings.HasPrefix(c, ":") {
				io.WriteString(w, c+"\n\n")
			} else {
				io.WriteString(w, "data: "+c+"\n\n")
			}
		}
	}))
}

func newServer(backend string) *server {
	return &server{backend: backend, model: "m", key: "secret-key", profile: spec.Compact,
		hosts: map[string]bool{"localhost": true, "127.0.0.1": true, "::1": true}, client: &http.Client{}}
}

func post(h http.Handler, body, host, origin, ctype string) *httptest.ResponseRecorder {
	r := httptest.NewRequest("POST", "http://"+host+"/api/chat", strings.NewReader(body))
	r.Host = host
	if origin != "" {
		r.Header.Set("Origin", origin)
	}
	r.Header.Set("Content-Type", ctype)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

const goodBody = `{"messages":[{"role":"user","content":"hi"}]}`

func TestChatStreamsAnswerAndThinking(t *testing.T) {
	var sent map[string]any
	var auth string
	up := fakeBackend(t, &sent, &auth)
	defer up.Close()
	s := newServer(up.URL)
	w := post(s.routes(), goodBody, "127.0.0.1:8090", "", "application/json")
	if w.Code != 200 {
		t.Fatalf("status %d: %s", w.Code, w.Body)
	}
	out := w.Body.String()
	for _, want := range []string{"event: think\ndata: \"hmm \"", "event: answer\ndata: \"<p>Hel\"", "event: answer\ndata: \"lo</p>\"", `event: ctrl` + "\n" + `data: {"type":"done"}`} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in\n%s", want, out)
		}
	}
	if auth != "Bearer secret-key" {
		t.Errorf("backend got Authorization %q", auth)
	}
	msgs := sent["messages"].([]any)
	first := msgs[0].(map[string]any)
	if first["role"] != "system" || first["content"] != spec.SystemPrompt(spec.Compact) {
		t.Errorf("first message to the backend should be the compact system prompt, got %v", first)
	}
	if sent["stream"] != true || sent["model"] != "m" {
		t.Errorf("request to backend: %v", sent)
	}
	if _, ok := sent["grammar"]; ok {
		t.Error("no grammar was configured, none should be sent")
	}
}

func TestGrammarIsForwardedWhenConfigured(t *testing.T) {
	var sent map[string]any
	var auth string
	up := fakeBackend(t, &sent, &auth)
	defer up.Close()
	s := newServer(up.URL)
	s.grammar = "root ::= \"x\""
	post(s.routes(), goodBody, "localhost:8090", "", "application/json")
	if sent["grammar"] != "root ::= \"x\"" {
		t.Errorf("grammar not forwarded: %v", sent["grammar"])
	}
}

func TestRejectsWhatItShould(t *testing.T) {
	var sent map[string]any
	var auth string
	up := fakeBackend(t, &sent, &auth)
	defer up.Close()
	h := newServer(up.URL).routes()
	cases := []struct {
		name               string
		body, host, origin string
		ctype              string
		want               int
	}{
		{"DNS rebinding: unexpected Host", goodBody, "evil.example", "http://evil.example", "application/json", 403},
		{"another site's Origin", goodBody, "127.0.0.1:8090", "https://evil.example", "application/json", 403},
		{"form content type (no preflight)", goodBody, "127.0.0.1:8090", "", "text/plain", 403},
		{"no messages", `{"messages":[]}`, "127.0.0.1:8090", "", "application/json", 400},
		{"a forged system message", `{"messages":[{"role":"system","content":"x"}]}`, "127.0.0.1:8090", "", "application/json", 400},
		{"same-origin page", goodBody, "localhost:8090", "http://localhost:8090", "application/json", 200},
	}
	for _, c := range cases {
		if got := post(h, c.body, c.host, c.origin, c.ctype).Code; got != c.want {
			t.Errorf("%s: status %d, want %d", c.name, got, c.want)
		}
	}
	r := httptest.NewRequest("GET", "http://evil.example/api/config", nil)
	r.Host = "evil.example"
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 403 {
		t.Errorf("GET with an unexpected Host: %d", w.Code)
	}
}

func TestConfigNeverLeaksTheKey(t *testing.T) {
	s := newServer("https://user:pass@api.example.com/v1")
	r := httptest.NewRequest("GET", "http://localhost/api/config", nil)
	r.Host = "localhost"
	w := httptest.NewRecorder()
	s.routes().ServeHTTP(w, r)
	body := w.Body.String()
	if strings.Contains(body, "secret-key") || strings.Contains(body, "pass") || strings.Contains(body, "/v1") {
		t.Errorf("config exposes more than the backend host: %s", body)
	}
	if !strings.Contains(body, "api.example.com") {
		t.Errorf("config should name the backend host: %s", body)
	}
}

func TestPageAndSubsetAreServedWithTheRightCSP(t *testing.T) {
	h := newServer("http://x").routes()
	get := func(path string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("GET", "http://localhost"+path, nil)
		r.Host = "localhost"
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}
	if w := get("/"); w.Code != 200 || !strings.Contains(w.Header().Get("Content-Security-Policy"), "script-src 'self'") {
		t.Errorf("index: %d csp=%q", w.Code, w.Header().Get("Content-Security-Policy"))
	}
	if w := get("/sandbox.html"); !strings.Contains(w.Header().Get("Content-Security-Policy"), "connect-src 'none'") {
		t.Errorf("sandbox must block all network: %q", w.Header().Get("Content-Security-Policy"))
	}
	w := get("/subset.json")
	var j map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &j); err != nil || j["version"] == nil {
		t.Errorf("subset.json: %v", err)
	}
	for _, p := range []string{"/app.js", "/render.js", "/sanitize.js", "/scanner.js", "/subset.js", "/style.css", "/themes/pico.css"} {
		if w := get(p); w.Code != 200 {
			t.Errorf("%s: %d", p, w.Code)
		}
	}
}
