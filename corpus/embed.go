// Package corpus carries the default prompts, so `conform sample` works from any directory.
package corpus

import _ "embed"

// Prompts is a JSON array of {q, needs}.
//
//go:embed prompts.json
var Prompts []byte
