# React standby UI

This directory is the independently mountable React implementation of the
MandelHowl UI contract. It receives a generation-scoped input lease from the
N-version supervisor and never owns or disposes the browser session.

The React adapter is loaded only when explicitly forced or when the Svelte 5
primary has a confirmed availability failure. Both adapters consume the same
presentation store, dial-input mapping, renderer and safe-audio runtime.
