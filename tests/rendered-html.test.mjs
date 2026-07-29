import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const projectRoot = new URL("../", import.meta.url);

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
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

test("server-renders the MandelHowl experiment shell", async () => {
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

  const html = await response.text();
  assert.match(html, /<title>MandelHowl — Resonance Volume Instrument<\/title>/i);
  assert.match(html, /Experimental acoustic interface/i);
  assert.match(html, /DRIVE FREQUENCY/i);
  assert.match(html, /Closed-loop Chladni apparatus/i);
  assert.match(html, /VOLUME/i);
  assert.match(html, />000</);
  assert.match(html, /ONE CONTROL \/ ONE RESULT \/ NO RANDOMNESS/i);
  assert.match(html, /role="slider"/i);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape/i);
});

test("removes starter-only source and metadata", async () => {
  const [page, layout, scene, packageJson] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/mandelhowl-scene.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);

  assert.match(page, /MandelHowlLab/);
  assert.match(layout, /MandelHowl — Resonance Volume Instrument/);
  assert.match(scene, /frequencyMin = 45/);
  assert.match(scene, /frequencyMax = 6_000/);
  assert.match(scene, /aria-valuemin=\{frequencyMin\}/);
  assert.match(scene, /aria-valuemax=\{frequencyMax\}/);
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
