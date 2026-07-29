# Svelte 5 vertical slice

This component proves the migration boundary without forking the physics,
renderer, audio or dataset algorithms. It consumes the same
`MandelHowlBrowserRuntimePort`, Svelte-compatible snapshot store,
presentation model, CSS class contract and ARIA dial semantics as the current
shell.

It is intentionally not the production entry point yet. The remaining scene,
route metadata, fixtures, authentication and hosting shell move only after the
existing JavaScript/CPU/dial-to-paint benchmark gate is met.
