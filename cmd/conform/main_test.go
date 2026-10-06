package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A backend that answers each prompt from a fixed script, in order.
func scripted(t *testing.T, answers []string, finish string) *httptest.Server {
	i := 0
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req map[string]any
		json.NewDecoder(r.Body).Decode(&req)
		msgs := req["messages"].([]any)
		if msgs[0].(map[string]any)["role"] != "system" || len(msgs) != 2 {
			t.Errorf("unexpected messages: %v", msgs)
		}
		a := answers[i%len(answers)]
		i++
		json.NewEncoder(w).Encode(map[string]any{
			"choices": []any{map[string]any{"message": map[string]string{"content": a}, "finish_reason": finish}},
			"usage":   map[string]int{"completion_tokens": 40},
		})
	}))
}

func TestSampleReport(t *testing.T) {
	up := scripted(t, []string{
		"<p>fine</p>",
		"<p>x <img src=\"https://evil.example/?d=1\"></p>",
		"```html\n<p>wrapped</p>\n```",
		"<table><thead><tr><th>a<tbody><tr><td>b</table>", // compact-only: invalid in the strict profile
	}, "stop")
	defer up.Close()
	dir := t.TempDir()
	pf := filepath.Join(dir, "p.json")
	os.WriteFile(pf, []byte(`[{"q":"one","needs":[]},{"q":"two","needs":[]},{"q":"three","needs":[]},{"q":"four","needs":["table"]}]`), 0o644)

	// capture the report by running sample against the scripted backend
	old := os.Stdout
	r, w, _ := os.Pipe()
	os.Stdout = w
	code := sample([]string{"-backend", up.URL, "-model", "test", "-prompts", pf, "-profile", "strict"})
	w.Close()
	os.Stdout = old
	var out strings.Builder
	buf := make([]byte, 4096)
	for {
		n, err := r.Read(buf)
		out.Write(buf[:n])
		if err != nil {
			break
		}
	}
	if code != 0 {
		t.Fatalf("exit %d\n%s", code, out.String())
	}
	got := out.String()
	// strict profile: answer 1 valid; answer 2 has an <img>; answer 3 fenced; answer 4 omits end tags
	for _, want := range []string{"valid as emitted        1/4 (25%)", "wrapped in a code fence 1/4", "element 1", "end-tag 1", "asked-for element present 1/1"} {
		if !strings.Contains(got, want) {
			t.Errorf("report is missing %q:\n%s", want, got)
		}
	}
}

func TestSampleCompactProfileAcceptsOmittedEndTags(t *testing.T) {
	up := scripted(t, []string{"<table><thead><tr><th>a<tbody><tr><td>b</table>"}, "stop")
	defer up.Close()
	dir := t.TempDir()
	pf := filepath.Join(dir, "p.json")
	os.WriteFile(pf, []byte(`[{"q":"one","needs":["table"]}]`), 0o644)
	old := os.Stdout
	r, w, _ := os.Pipe()
	os.Stdout = w
	sample([]string{"-backend", up.URL, "-model", "m", "-prompts", pf, "-profile", "compact"})
	w.Close()
	os.Stdout = old
	b := make([]byte, 4096)
	n, _ := r.Read(b)
	if !strings.Contains(string(b[:n]), "valid as emitted        1/1 (100%)") {
		t.Errorf("compact profile should accept it:\n%s", b[:n])
	}
}

func TestCutOffAnswersAreCounted(t *testing.T) {
	up := scripted(t, []string{"<p>half an answ"}, "length")
	defer up.Close()
	dir := t.TempDir()
	pf := filepath.Join(dir, "p.json")
	os.WriteFile(pf, []byte(`[{"q":"one","needs":[]}]`), 0o644)
	old := os.Stdout
	r, w, _ := os.Pipe()
	os.Stdout = w
	sample([]string{"-backend", up.URL, "-model", "m", "-prompts", pf})
	w.Close()
	os.Stdout = old
	b := make([]byte, 4096)
	n, _ := r.Read(b)
	if !strings.Contains(string(b[:n]), "cut off by the limit    1/1") {
		t.Errorf("a length-stopped answer must be reported:\n%s", b[:n])
	}
}
