package tokens

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// A stand-in /tokenize that splits on spaces and returns pieces the way llama-server does.
func fake(t *testing.T, pieces func(text string) []any) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Content    string `json:"content"`
			WithPieces bool   `json:"with_pieces"`
			Model      string `json:"model"`
		}
		json.NewDecoder(r.Body).Decode(&req)
		if !req.WithPieces || req.Model != "m1" {
			t.Errorf("request: %+v", req)
		}
		var toks []map[string]any
		for _, p := range pieces(req.Content) {
			toks = append(toks, map[string]any{"id": 1, "piece": p})
		}
		json.NewEncoder(w).Encode(map[string]any{"tokens": toks})
	}))
}

func TestTokenizeReturnsByteRanges(t *testing.T) {
	// "<p>é!" is 5 bytes: "<p", ">", then é as two raw bytes (a piece that is not valid UTF-8 alone), then "!"
	srv := fake(t, func(string) []any { return []any{"<p", ">", []int{0xc3}, []int{0xa9}, "!"} })
	defer srv.Close()
	c := &Client{BaseURL: srv.URL, Model: "m1"}
	got, err := c.Tokenize(context.Background(), "<p>é!")
	if err != nil {
		t.Fatal(err)
	}
	want := []Span{{0, 2}, {2, 3}, {3, 4}, {4, 5}, {5, 6}}
	if len(got) != len(want) {
		t.Fatalf("got %v", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("span %d = %v, want %v", i, got[i], want[i])
		}
	}
}

func TestPiecesThatDoNotCoverTheTextAreAnError(t *testing.T) {
	srv := fake(t, func(string) []any { return []any{"<p", ">"} })
	defer srv.Close()
	c := &Client{BaseURL: srv.URL, Model: "m1"}
	if _, err := c.Tokenize(context.Background(), "<p>longer than the pieces"); err == nil {
		t.Error("numbers built on a mismatched tokenization cannot be trusted; it must fail")
	}
}

func TestHTTPErrorIsReported(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Error(w, "nope", 500) }))
	defer srv.Close()
	if _, err := (&Client{BaseURL: srv.URL}).Count(context.Background(), "x"); err == nil {
		t.Error("expected an error")
	}
}
