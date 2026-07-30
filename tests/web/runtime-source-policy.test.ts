import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  forbiddenRuntimeReasons,
  isRuntimeSourcePath,
} from "../../tools/release-packager/src/runtime-source-policy.mjs";

describe("runtime source policy", () => {
  it("covers Svelte source and rejects raw HTML injection", () => {
    expect(isRuntimeSourcePath("apps/example/Control.svelte")).toBe(true);
    expect(forbiddenRuntimeReasons("<p>{@html untrusted}</p>")).toContain(
      "Svelte raw HTML injection is forbidden",
    );
  });

  it("applies the same deterministic and HTML rules to framework sources", () => {
    expect(
      forbiddenRuntimeReasons(
        "const value = Math.random(); const props = { dangerouslySetInnerHTML: html };",
      ),
    ).toEqual([
      "Math.random is forbidden in deterministic runtime source",
      "external or untrusted HTML injection is forbidden",
    ]);
    expect(forbiddenRuntimeReasons("<p>{safeText}</p>")).toEqual([]);
  });

  it("blocks computed randomness, permission APIs and HTML sinks", () => {
    const source = `
      Math["random"]();
      navigator?.mediaDevices.getUserMedia?.({ audio: true });
      navigator["geolocation"].watchPosition(() => {});
      navigator.permissions.query({ name: "camera" });
      element.innerHTML = external;
    `;
    const reasons = forbiddenRuntimeReasons(source);
    expect(reasons).toContain(
      "computed Math.random is forbidden in deterministic runtime source",
    );
    expect(reasons).toContain(
      "runtime device/location permission APIs are forbidden",
    );
    expect(reasons).toContain("runtime permission requests are forbidden");
    expect(reasons).toContain(
      "imperative HTML injection sinks are forbidden",
    );
  });

  it("blocks operating-system master-volume APIs, commands, and native bridges", () => {
    const directControls = forbiddenRuntimeReasons(`
      endpoint.SetMasterVolumeLevelScalar(1, null);
      setSystemVolume(100);
      set_master_volume(100);
      exec("pactl set-sink-volume @DEFAULT_SINK@ 100%");
    `);
    expect(directControls).toContain(
      "operating-system or device master-volume control is forbidden",
    );

    for (const bridgeMutation of [
      'ipcRenderer.invoke("set-system-volume", 100);',
      'window.__TAURI__.core.invoke("set_master_volume", { value: 100 });',
      'window.chrome.webview.postMessage({ command: "set-volume" });',
      'window.webkit.messageHandlers.volume.postMessage(100);',
      'window.ReactNativeWebView.postMessage("set-volume:100");',
      'window.external.notify("set-system-volume:100");',
      'Capacitor.Plugins.SystemVolume.set({ level: 1 });',
    ]) {
      expect(
        forbiddenRuntimeReasons(bridgeMutation),
        bridgeMutation,
      ).toContain(
        "native host bridges capable of operating-system control are forbidden",
      );
    }
  });

  it("keeps native execution and offline tooling out of the browser runtime", () => {
    for (const nativeMutation of [
      'import { spawn } from "node:child_process";',
      'const fs = require("fs");',
      'const builtin = process.getBuiltinModule("node:child_process");',
      'const hidden = process["binding"]("spawn_sync");',
      'new Deno.Command("powershell.exe");',
      'Bun.spawn(["cmd.exe", "/c", "echo"]);',
    ]) {
      expect(
        forbiddenRuntimeReasons(nativeMutation, "app/native-mutation.ts"),
        nativeMutation,
      ).toContain(
        "native process and filesystem modules are forbidden in browser runtime",
      );
    }
    expect(
      forbiddenRuntimeReasons(
        'import { generate } from "../../tools/physics-baker/index.mjs";',
        "apps/svelte-ui/src/native-mutation.ts",
      ),
    ).toContain(
      "offline baker and release tools are forbidden in browser runtime",
    );
    expect(
      forbiddenRuntimeReasons(
        'import { readFile } from "node:fs/promises";',
        "packages/example/src/policy.test.ts",
      ),
    ).not.toContain(
      "native process and filesystem modules are forbidden in browser runtime",
    );
  });

  it("blocks outbound channels and absolute fetch while allowing local assets", () => {
    const denied = forbiddenRuntimeReasons(`
      navigator.sendBeacon("/trace", bytes);
      new WebSocket("wss://collector.invalid");
      new EventSource("/events");
      new XMLHttpRequest();
      fetch("https://collector.invalid/input-trace");
    `);
    expect(denied).toContain("outbound beacon telemetry is forbidden");
    expect(denied).toContain(
      "unversioned outbound runtime channels are forbidden",
    );
    expect(denied).toContain(
      "absolute-origin runtime fetch is forbidden; use verified local assets",
    );
    expect(
      forbiddenRuntimeReasons(
        'fetch("/runtime/manifest.json", { credentials: "same-origin" });',
      ),
    ).toEqual([]);
  });

  it("blocks obvious per-value lookup aliases", () => {
    expect(
      forbiddenRuntimeReasons("const forced = volumeLookup[settledVolume];"),
    ).toContain("per-value runtime output lookup tables are forbidden");
  });

  it("keeps value-indexed reachability search outside the production runtime package", async () => {
    const root = new URL("../../", import.meta.url);
    const [runtimeIndex, offlineCoverage, generator, staticScanner] =
      await Promise.all([
      readFile(
        new URL("packages/resonance-engine/src/index.ts", root),
        "utf8",
      ),
      readFile(
        new URL(
          "tools/reachability-generator/src/trajectory-coverage.ts",
          root,
        ),
        "utf8",
      ),
      readFile(
        new URL(
          "tests/runtime/generate-reachability-report.ts",
          root,
        ),
        "utf8",
      ),
      readFile(
        new URL(
          "tools/release-packager/src/verify-forbidden-runtime.mjs",
          root,
        ),
        "utf8",
      ),
    ]);
    expect(runtimeIndex).not.toContain("trajectory-coverage");
    expect(runtimeIndex).not.toContain("searchReachabilityCoverage");
    expect(offlineCoverage).toMatch(
      /tracesByVolume\.has\((?:replay\.)?settledVolume\)/u,
    );
    expect(generator).toContain(
      "../../tools/reachability-generator/src/trajectory-coverage",
    );
    expect(staticScanner).not.toMatch(/^\s*"tools",?\s*$/mu);
  });

  it("blocks randomness references hidden behind aliases", () => {
    const reasons = forbiddenRuntimeReasons(`
      const mathFacade = globalThis.Math;
      const rng = mathFacade.random;
      const { random: destructuredRng } = Math;
      const reflectedRng = Reflect.get(Math, "random");
      rng();
      destructuredRng();
      reflectedRng();
    `);
    expect(reasons).toContain(
      "Math.random is forbidden in deterministic runtime source",
    );
    expect(
      forbiddenRuntimeReasons(
        'const rng = Reflect.get(Math, "random"); rng();',
      ),
    ).toContain(
      "computed Math.random is forbidden in deterministic runtime source",
    );
  });

  it("blocks output-indexed tables regardless of the table or alias name", () => {
    const reasons = forbiddenRuntimeReasons(`
      const chosenOutput = snapshot.volume.value;
      const innocuousName = Object.freeze(["not", "an", "exception"]);
      const forced = innocuousName[chosenOutput];
      const alternate = new Map();
      alternate.get(chosenOutput);
    `);
    expect(reasons).toContain(
      "per-value runtime output lookup tables are forbidden",
    );
    expect(
      forbiddenRuntimeReasons(`
        const modeIndex = snapshot.modes.length - 1;
        const mode = modes[modeIndex];
      `),
    ).toEqual([]);
  });

  it("blocks aliased output switches and literal exceptions", () => {
    const reasons = forbiddenRuntimeReasons(`
      const answer = snapshot.volume.value;
      if (answer === 42) throw new Error("special output");
      switch (answer) {
        case 7: return "forced";
        default: return "physical";
      }
    `);
    expect(reasons).toContain(
      "per-value runtime output exceptions are forbidden",
    );
    expect(reasons).toContain(
      "per-value runtime output switches are forbidden",
    );
  });

  it("blocks same-origin trace transmission, including fetch aliases", () => {
    const reasons = forbiddenRuntimeReasons(`
      const endpoint = "/runtime/input-trace";
      const transmit = window.fetch.bind(window);
      const requestOptions = {
        method: "POST",
        body: JSON.stringify(dialTrace),
      };
      transmit(endpoint, requestOptions);
      fetch(new Request("/diagnostic/trace", requestOptions));
    `);
    expect(reasons).toContain(
      "state-changing runtime fetch is forbidden; input traces must remain local",
    );
    expect(
      forbiddenRuntimeReasons(`
        const endpoint = "/runtime/manifest.json";
        const load = globalThis.fetch;
        load(endpoint, { credentials: "same-origin" });
      `),
    ).toEqual([]);
  });

  it("blocks computed and destructured beacon transmission aliases", () => {
    const reasons = forbiddenRuntimeReasons(`
      const key = "sendBeacon";
      const transmit = navigator[key];
      const { sendBeacon: secondTransmit } = navigator;
      transmit("/trace", bytes);
      secondTransmit("/trace", bytes);
    `);
    expect(reasons).toContain("outbound beacon telemetry is forbidden");
  });

  it("keeps callback helpers out of the renderer animation hot path", async () => {
    const root = new URL("../../", import.meta.url);
    const [types, webgl, canvas] = await Promise.all([
      readFile(
        new URL("packages/render-engine/src/render-types.ts", root),
        "utf8",
      ),
      readFile(
        new URL(
          "packages/render-engine/src/webgl-plate-renderer.ts",
          root,
        ),
        "utf8",
      ),
      readFile(
        new URL(
          "packages/render-engine/src/canvas-plate-renderer.ts",
          root,
        ),
        "utf8",
      ),
    ]);
    expect(types).not.toContain("snapshot.modes.some");
    expect(webgl).not.toContain("fallbackModes?.find");
    expect(canvas).not.toContain("fallbackModes?.find");
  });

  it("keeps renderer texture acquisition behind verified loadBytes providers", async () => {
    const root = new URL("../../", import.meta.url);
    const [decoder, publicIndex, cache] = await Promise.all([
      readFile(
        new URL("packages/render-engine/src/ktx2-texture.ts", root),
        "utf8",
      ),
      readFile(
        new URL("packages/render-engine/src/index.ts", root),
        "utf8",
      ),
      readFile(
        new URL("packages/render-engine/src/texture-shard-cache.ts", root),
        "utf8",
      ),
    ]);
    expect(decoder).not.toContain("fetchPortableKtx2");
    expect(decoder).not.toMatch(/\bfetch\s*\(/u);
    expect(publicIndex).not.toContain("fetchPortableKtx2");
    expect(cache).toContain("source.loadBytes");
    expect(cache).not.toMatch(/\bfetch\s*\(/u);
  });

  it("keeps offline baker artifacts outside the UI development watcher", async () => {
    const viteConfig = await readFile(
      new URL("../../vite.config.ts", import.meta.url),
      "utf8",
    );
    for (const ignoredPath of [
      "**/target/**",
      "**/tools/physics-baker-rs/bin/**",
      "**/assets/generated/**",
      "**/outputs/**",
      "**/work/**",
      "**/.cache/**",
    ]) {
      expect(viteConfig).toContain(`"${ignoredPath}"`);
    }
  });

  it("keeps local browser tests on portable Vite without weakening the deployment Worker", async () => {
    const root = new URL("../../", import.meta.url);
    const [viteConfig, playwrightConfig] = await Promise.all([
      readFile(new URL("vite.config.ts", root), "utf8"),
      readFile(new URL("playwright.config.ts", root), "utf8"),
    ]);
    expect(playwrightConfig).toContain(
      'MANDELHOWL_PORTABLE_BROWSER_TEST_SERVER: "1"',
    );
    expect(viteConfig).toContain(
      'process.env.MANDELHOWL_PORTABLE_BROWSER_TEST_SERVER === "1"',
    );
    expect(viteConfig).toMatch(
      /usesPortableBrowserTestServer\s*\?\s*\[\]\s*:\s*\[/u,
    );
    expect(viteConfig).toContain('await import("@cloudflare/vite-plugin")');
    expect(viteConfig).toContain("config: localBindingConfig");
  });

  it("does not expose an unused dynamic image-transform route", async () => {
    const worker = await readFile(
      new URL("../../worker/index.ts", import.meta.url),
      "utf8",
    );
    expect(worker).not.toContain("handleImageOptimization");
    expect(worker).not.toContain("/_vinext/image");
    expect(worker).not.toContain("IMAGES:");
  });
});
