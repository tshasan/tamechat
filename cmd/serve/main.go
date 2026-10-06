// Command serve is the demo server: it serves the page and proxies chat to ANY OpenAI-compatible
// backend (llama.cpp, Ollama, vLLM, a hosted API), streaming the answer back as Server-Sent Events.
//
//	go run ./cmd/serve -backend http://127.0.0.1:8081/v1 -model qwen3.6
//	OPENAI_API_KEY=... go run ./cmd/serve -backend https://api.openai.com/v1 -model <model> -key-env OPENAI_API_KEY
//
// The server adds the subset's system prompt and, when you pass -grammar and the backend is
// llama.cpp, a grammar. Nothing else is vendor-specific: switching backends is a flag.
package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log"
	"mime"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"

	"html-answers/spec"
	"html-answers/web"
)

type server struct {
	backend string // base URL ending in /v1
	model   string
	key     string
	profile spec.Profile
	grammar string
	extra   map[string]any
	hosts   map[string]bool
	client  *http.Client
}

func main() {
	addr := flag.String("addr", "127.0.0.1:8090", "listen address (loopback by default: this has no authentication)")
	backend := flag.String("backend", "http://127.0.0.1:8081/v1", "OpenAI-compatible base URL, ending in /v1")
	model := flag.String("model", "", "model id sent to the backend")
	keyEnv := flag.String("key-env", "", "name of the environment variable holding the backend's API key")
	profile := flag.String("profile", "strict", "strict or compact: which system prompt to teach the model")
	grammarPath := flag.String("grammar", "", "GBNF file to send as the grammar (llama.cpp only)")
	extra := flag.String("extra", "", "JSON object merged into every request to the backend, for backend-specific options")
	flag.Parse()

	if *profile != "strict" && *profile != "compact" {
		log.Fatal("-profile must be strict or compact")
	}
	s := &server{backend: strings.TrimRight(*backend, "/"), model: *model, profile: spec.Profile(*profile),
		hosts: map[string]bool{"localhost": true, "127.0.0.1": true, "::1": true}, client: &http.Client{}}
	if *keyEnv != "" {
		if s.key = os.Getenv(*keyEnv); s.key == "" {
			log.Fatalf("-key-env %s is empty", *keyEnv)
		}
	}
	if *extra != "" {
		if err := json.Unmarshal([]byte(*extra), &s.extra); err != nil {
			log.Fatal("-extra must be a JSON object: ", err)
		}
	}
	if *grammarPath != "" {
		g, err := os.ReadFile(*grammarPath)
		if err != nil {
			log.Fatal(err)
		}
		s.grammar = string(g)
	}
	if h, _, err := net.SplitHostPort(*addr); err == nil && h != "" && h != "0.0.0.0" && h != "::" {
		s.hosts[h] = true
	} else if h == "0.0.0.0" || h == "::" {
		log.Print("warning: listening on all interfaces. There is no authentication; anyone who can reach this port can use your backend.")
	}
	log.Printf("page: http://%s/  backend: %s  model: %q  profile: %s  grammar: %v", *addr, redact(s.backend), s.model, s.profile, s.grammar != "")
	log.Fatal(http.ListenAndServe(*addr, s.routes()))
}

func (s *server) routes() http.Handler {
	mux := http.NewServeMux()
	static, _ := fs.Sub(web.FS, ".")
	files := http.FileServer(http.FS(static))
	mux.HandleFunc("/subset.json", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write(spec.JSON())
	})
	mux.HandleFunc("/api/config", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]any{"backend": redact(s.backend), "model": s.model, "profile": s.profile, "grammar": s.grammar != ""})
	})
	mux.HandleFunc("/api/chat", s.chat)
	mux.Handle("/", files)
	return s.guard(mux)
}

// guard applies the checks every request needs. A page on another site must not be able to read
// or use a server on localhost, including by DNS rebinding (an attacker's name pointing at
// 127.0.0.1), so the Host header has to be one we expect.
func (s *server) guard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host := r.Host
		if h, _, err := net.SplitHostPort(r.Host); err == nil {
			host = h
		}
		if !s.hosts[strings.Trim(host, "[]")] {
			http.Error(w, "unexpected Host header", http.StatusForbidden)
			return
		}
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		if r.URL.Path == "/sandbox.html" {
			// Widget host: inline script and style only, no network of any kind.
			h.Set("Content-Security-Policy", "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; "+
				"img-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'")
		} else {
			// The page: only our own scripts, so model HTML cannot add any even if every other layer failed.
			h.Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "+
				"img-src 'self' data:; frame-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'")
		}
		next.ServeHTTP(w, r)
	})
}

type message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

func (s *server) chat(w http.ResponseWriter, r *http.Request) {
	// A POST from another website must not be able to use this: require our own origin and a JSON
	// content type, which forces a CORS preflight that is never answered.
	mt, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if r.Method != http.MethodPost || mt != "application/json" || !sameOrigin(r) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	var req struct {
		Messages []message `json:"messages"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil || len(req.Messages) == 0 || len(req.Messages) > 200 {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	msgs := []message{{Role: "system", Content: spec.SystemPrompt(s.profile)}}
	for _, m := range req.Messages {
		if m.Role != "user" && m.Role != "assistant" {
			http.Error(w, "bad role", http.StatusBadRequest)
			return
		}
		msgs = append(msgs, m)
	}
	body := map[string]any{"model": s.model, "messages": msgs, "stream": true}
	if s.grammar != "" {
		body["grammar"] = s.grammar
	}
	for k, v := range s.extra {
		if _, taken := body[k]; !taken { // the options we set ourselves win
			body[k] = v
		}
	}
	b, _ := json.Marshal(body)
	up, _ := http.NewRequestWithContext(r.Context(), "POST", s.backend+"/chat/completions", bytes.NewReader(b))
	up.Header.Set("Content-Type", "application/json")
	if s.key != "" {
		up.Header.Set("Authorization", "Bearer "+s.key)
	}
	resp, err := s.client.Do(up)
	if err != nil {
		http.Error(w, "backend unreachable: "+err.Error(), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 400))
		http.Error(w, fmt.Sprintf("backend answered %d: %s", resp.StatusCode, msg), http.StatusBadGateway)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Accel-Buffering", "no")
	fl, _ := w.(http.Flusher)
	send := func(event string, v any) {
		// No HTML escaping: this JSON never sits inside a page, and escaping turns every "<" of a
		// tag into six bytes on the wire.
		var j bytes.Buffer
		enc := json.NewEncoder(&j)
		enc.SetEscapeHTML(false)
		enc.Encode(v)
		fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, bytes.TrimRight(j.Bytes(), "\n"))
		if fl != nil {
			fl.Flush()
		}
	}
	sc := bufio.NewScanner(resp.Body)
	sc.Buffer(make([]byte, 64<<10), 4<<20)
	for sc.Scan() {
		line := sc.Text()
		if !strings.HasPrefix(line, "data: ") {
			continue // keep-alives and comments
		}
		data := line[6:]
		if data == "[DONE]" {
			break
		}
		var chunk struct {
			Choices []struct {
				Delta struct {
					Content   string `json:"content"`
					Reasoning string `json:"reasoning_content"`
					Thinking  string `json:"reasoning"`
				} `json:"delta"`
			} `json:"choices"`
			Error *struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		if json.Unmarshal([]byte(data), &chunk) != nil {
			continue
		}
		if chunk.Error != nil {
			send("ctrl", map[string]string{"type": "error", "message": chunk.Error.Message})
			return
		}
		for _, c := range chunk.Choices {
			if t := c.Delta.Reasoning + c.Delta.Thinking; t != "" {
				send("think", t)
			}
			if c.Delta.Content != "" {
				send("answer", c.Delta.Content)
			}
		}
	}
	if err := sc.Err(); err != nil && r.Context().Err() == nil {
		send("ctrl", map[string]string{"type": "error", "message": err.Error()})
		return
	}
	send("ctrl", map[string]string{"type": "done"})
}

// sameOrigin accepts requests with no Origin (curl) or an Origin on the same host.
func sameOrigin(r *http.Request) bool {
	o := r.Header.Get("Origin")
	if o == "" {
		return true
	}
	u, err := url.Parse(o)
	if err != nil {
		return false
	}
	host := r.Host
	if h, _, err := net.SplitHostPort(r.Host); err == nil {
		host = h
	}
	return strings.EqualFold(u.Hostname(), host)
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	json.NewEncoder(w).Encode(v)
}

// redact shows where the backend is without credentials or a path.
func redact(raw string) string {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return "backend"
	}
	return u.Host
}
