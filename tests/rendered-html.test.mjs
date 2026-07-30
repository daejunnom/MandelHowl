import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const projectRoot = new URL("../", import.meta.url);

async function staticRootHeaders() {
  const source = await readFile(
    new URL("../public/_headers", import.meta.url),
    "utf8",
  );
  const rootBlock = source.split(/\r?\n\r?\n/, 1)[0] ?? "";
  return new Map(
    rootBlock
      .split(/\r?\n/)
      .map((line) => /^\s{2}([^:]+):\s*(.+)$/.exec(line))
      .filter((match) => match !== null)
      .map((match) => [match[1], match[2]]),
  );
}

async function render(pathname = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(new URL(pathname, "http://localhost/"), {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("does not expose development-only fixture routes in production", async () => {
  for (const pathname of [
    "/visual-fixture/critical",
    "/audio-safety-fixture",
  ]) {
    const response = await render(pathname);
    assert.equal(response.status, 404, pathname);
  }
});

test("server-renders the framework-neutral MandelHowl N-version shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  assert.match(
    response.headers.get("content-security-policy") ?? "",
    /default-src 'self'/,
  );
  assert.match(
    response.headers.get("permissions-policy") ?? "",
    /microphone=\(\)/,
  );
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("x-frame-options"), "SAMEORIGIN");
  for (const [name, expectedValue] of await staticRootHeaders()) {
    assert.equal(response.headers.get(name), expectedValue, name);
  }

  const html = await response.text();
  assert.match(html, /<title>MandelHowl — Resonance Volume Instrument<\/title>/i);
  assert.match(html, /class="mh-session-canvas"/i);
  assert.match(html, /class="mh-ui-nversion-host"/i);
  assert.match(html, /data-ui-phase="idle"/i);
  assert.match(html, /MH-UI-PRIMARY-LOADING/i);
  assert.match(html, /Loading verified instrument interface/i);
  assert.match(html, /role="status"/i);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape/i);
});

test("removes starter-only source and metadata", async () => {
  const [page, layout, scene, svelteScene, packageJson] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/mandelhowl-scene.tsx", import.meta.url), "utf8"),
    readFile(
      new URL("../apps/svelte-ui/src/MandelHowlApp.svelte", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);

  assert.match(page, /MandelHowlLab/);
  assert.match(layout, /MandelHowl — Resonance Volume Instrument/);
  assert.match(scene, /GENERATED_DIAL_SPEC/);
  assert.match(
    scene,
    /frequencyMin = GENERATED_DIAL_SPEC\.mapping\.minimumFrequencyHz/,
  );
  assert.match(
    scene,
    /frequencyMax = GENERATED_DIAL_SPEC\.mapping\.maximumFrequencyHz/,
  );
  assert.match(scene, /aria-valuemin=\{frequencyMin\}/);
  assert.match(scene, /aria-valuemax=\{frequencyMax\}/);
  assert.match(svelteScene, /data-ui-implementation="svelte5"/);
  assert.match(svelteScene, /role="slider"/);
  assert.match(svelteScene, /aria-valuemin=\{frequencyMin\}/);
  assert.match(svelteScene, /aria-valuemax=\{frequencyMax\}/);
  assert.match(packageJson, /"name": "mandelhowl"/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  assert.doesNotMatch(page + layout, /codex-preview|_sites-preview/);

  await assert.rejects(
    access(new URL("app/_sites-preview/SkeletonPreview.tsx", projectRoot)),
  );
  await assert.rejects(
    access(new URL("app/_sites-preview/preview.css", projectRoot)),
  );
});
