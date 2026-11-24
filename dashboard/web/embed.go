// Package web embeds the built galley SPA (dashboard/web/dist) into the Go binary.
// Run `npm run build` in this directory first; dist/.gitkeep keeps the embed valid
// (and the binary buildable) before the SPA has been built.
package web

import "embed"

//go:embed all:dist
var Dist embed.FS
