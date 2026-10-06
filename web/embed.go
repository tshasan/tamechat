// Package web embeds the demo page so the server is one self-contained binary.
package web

import "embed"

//go:embed index.html app.js render.js sanitize.js scanner.js subset.js style.css sandbox.html themes/*.css
var FS embed.FS
