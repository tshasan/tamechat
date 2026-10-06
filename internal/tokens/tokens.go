// Package tokens measures token counts through a llama-server's own tokenizer.
//
// Using the model's real tokenizer matters: the whole question is how many tokens a format costs,
// and that is a property of a tokenizer, not of the text.
package tokens

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
)

// Client talks to a llama-server (or its router) at BaseURL.
type Client struct {
	BaseURL string
	Model   string // router mode needs it; empty otherwise
	HTTP    *http.Client
}

// Span is one token's byte range in the text it came from.
type Span struct{ Start, End int }

// Tokenize returns each token's byte range. The pieces llama-server returns concatenate back
// to the input, so the ranges tile the text; an error is returned if they do not.
func (c *Client) Tokenize(ctx context.Context, text string) ([]Span, error) {
	body, _ := json.Marshal(map[string]any{"content": text, "add_special": false, "with_pieces": true, "model": c.Model})
	req, _ := http.NewRequestWithContext(ctx, "POST", c.BaseURL+"/tokenize", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	h := c.HTTP
	if h == nil {
		h = http.DefaultClient
	}
	resp, err := h.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 300))
		return nil, fmt.Errorf("tokenize: %d %s", resp.StatusCode, msg)
	}
	var out struct {
		Tokens []struct {
			Piece json.RawMessage `json:"piece"`
		} `json:"tokens"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, err
	}
	spans := make([]Span, len(out.Tokens))
	pos := 0
	for i, t := range out.Tokens {
		n, err := pieceLen(t.Piece)
		if err != nil {
			return nil, err
		}
		spans[i] = Span{pos, pos + n}
		pos += n
	}
	if pos != len(text) {
		return nil, fmt.Errorf("tokenize: pieces cover %d bytes of %d", pos, len(text))
	}
	return spans, nil
}

// Count is len(Tokenize).
func (c *Client) Count(ctx context.Context, text string) (int, error) {
	s, err := c.Tokenize(ctx, text)
	return len(s), err
}

// A piece is a JSON string, or an array of byte values when the token is not valid UTF-8 alone.
func pieceLen(raw json.RawMessage) (int, error) {
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return len(s), nil
	}
	var bs []int
	if json.Unmarshal(raw, &bs) == nil {
		return len(bs), nil
	}
	return 0, errors.New("tokenize: unreadable piece")
}
