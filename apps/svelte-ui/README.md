# Svelte 5 production UI

This directory is the independently compiled Svelte 5 implementation of the
MandelHowl presentation contract. It does not own or reimplement resonance,
dial, audio, dataset or renderer algorithms.

`MandelHowlApp.svelte` consumes only the framework-neutral browser runtime
port. It renders the same CSS and ARIA scene contract as the React standby,
dispatches every pointer, keyboard and wheel input through the canonical dial
engine, and activates the single shared safe-audio graph from the originating
user gesture.

`entry.ts` exposes both the direct `mountMandelHowlSvelte` mount used by the
client host and `createSvelteUiImplementation` for `UiNVersionSupervisor`.
The supervisor owns the runtime and can detach this view without disposing
scientific state, dataset state or audio. Readiness, committed snapshot
heartbeats and Svelte boundary failures are reported through the supervisor
contract. Generation-scoped input leases use the canonical DOM event type and
timestamp as their replay-resistant event identity.
