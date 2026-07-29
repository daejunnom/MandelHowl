<script lang="ts">
  import type { MandelHowlBrowserRuntimePort } from "../../../packages/browser-runtime/src";
  import type { RuntimeSnapshot } from "../../../packages/contracts/src";
  import type { DialKeyboardKey } from "../../../packages/dial-engine/src";
  import { presentOscilloscope } from "../../../packages/presentation-model/src";

  let { runtime }: { runtime: MandelHowlBrowserRuntimePort } = $props();
  let snapshot = $state<RuntimeSnapshot | null>(null);

  $effect(() => {
    const snapshots = runtime.snapshots;
    snapshot = snapshots.getSnapshot();
    return snapshots.subscribe((next) => {
      snapshot = next;
    });
  });

  let scope = $derived(snapshot
    ? presentOscilloscope({
        recentSamples: snapshot.microphone.recentSamples,
        rmsNormalized: snapshot.microphone.rmsNormalized,
        peakNormalized: snapshot.microphone.peakNormalized,
      })
    : null);

  const dialKeys = new Set<string>([
    "ArrowLeft",
    "ArrowRight",
    "ArrowDown",
    "ArrowUp",
    "PageDown",
    "PageUp",
    "Home",
    "End",
  ]);

  function formatFrequency(frequencyHz: number): string {
    return frequencyHz >= 1_000
      ? `${Number((frequencyHz / 1_000).toPrecision(3))} kHz`
      : `${frequencyHz.toFixed(frequencyHz < 100 ? 1 : 0)} Hz`;
  }

  function onkeydown(event: KeyboardEvent): void {
    if (!dialKeys.has(event.key)) return;
    event.preventDefault();
    runtime.dispatchDial({
      type: "keyboard",
      key: event.key as DialKeyboardKey,
      timestampMs: event.timeStamp,
    });
  }

  function onwheel(event: WheelEvent): void {
    event.preventDefault();
    runtime.dispatchDial({
      type: "wheel",
      deltaY: event.deltaY,
      timestampMs: event.timeStamp,
    });
  }
</script>

{#if snapshot && scope}
<section class="mh-svelte-control-slice" aria-label="Svelte 5 control prototype">
  <div
    class="mh-dial"
    role="slider"
    tabindex="0"
    aria-label="Drive frequency"
    aria-valuemin="45"
    aria-valuemax="6000"
    aria-valuenow={Math.round(snapshot.dial.driveFrequencyHz)}
    aria-valuetext={formatFrequency(snapshot.dial.driveFrequencyHz)}
    onkeydown={onkeydown}
    onwheel={onwheel}
  >
    <span class="mh-dial-scale" aria-hidden="true"></span>
    <span class="mh-dial-track" aria-hidden="true"></span>
    <span class="mh-dial-face">
      <span class="mh-dial-type">DRIVE FREQUENCY</span>
      <strong>{formatFrequency(snapshot.dial.driveFrequencyHz)}</strong>
      <span class="mh-dial-hint">SVELTE 5 VERTICAL SLICE</span>
    </span>
  </div>

  <div
    class="mh-oscilloscope"
    role="img"
    aria-label={`Microphone waveform; RMS ${scope.rmsPercent} percent, peak ${scope.peakPercent} percent`}
  >
    <div class="mh-instrument-label">
      <span>MIC SIGNAL</span>
      <strong>OSCILLOSCOPE</strong>
    </div>
    <div class="mh-scope-screen" aria-hidden="true">
      <i class="mh-scope-zero"></i>
      {#each scope.samples as sample}
        <span
          class="mh-scope-sample"
          style={`--scope-magnitude: ${Math.abs(sample)}; --scope-sign: ${sample < 0 ? -1 : 1}`}
        ></span>
      {/each}
    </div>
    <p>
      RMS {scope.rmsPercent.toString().padStart(3, "0")}
      <span>GAIN ×{scope.autoGainLinear.toFixed(1)}</span>
    </p>
  </div>
</section>
{/if}
