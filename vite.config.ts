import vinext from "vinext";
import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import hostingConfig from "./.openai/hosting.json";
import { sites } from "./build/sites-vite-plugin";

const SITE_CREATOR_PLACEHOLDER_DATABASE_ID =
  "00000000-0000-4000-8000-000000000000";

const { d1, r2 } = hostingConfig;

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";

const localBindingConfig = {
  main: "./worker/index.ts",
  compatibility_flags: ["nodejs_compat"],
  d1_databases: d1
    ? [
        {
          binding: d1,
          database_name: "site-creator-d1",
          database_id: SITE_CREATOR_PLACEHOLDER_DATABASE_ID,
        },
      ]
    : [],
  r2_buckets: r2
    ? [
        {
          binding: r2,
          bucket_name: "site-creator-r2",
        },
      ]
    : [],
};

export default defineConfig(async () => {
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  // Browser regression tests exercise the portable vinext/Vite server. They
  // do not need Worker bindings, and must not spawn workerd/Miniflare on
  // Windows where Application Control can reject that extra native surface.
  // Production builds keep the Cloudflare plugin and exact Worker contract.
  const usesPortableBrowserTestServer =
    process.env.MANDELHOWL_PORTABLE_BROWSER_TEST_SERVER === "1";
  const cloudflarePlugins = usesPortableBrowserTestServer
    ? []
    : [
        (
          // Wrangler snapshots its log path while this plugin is imported.
          await import("@cloudflare/vite-plugin")
        ).cloudflare({
          viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
          config: localBindingConfig,
        }),
      ];

  const ignoredRuntimeArtifacts = [
    "**/playwright-report/**",
    "**/test-results/**",
    "**/coverage/**",
    "**/release/archives/**",
    "**/target/**",
    "**/tools/physics-baker-rs/bin/**",
    "**/assets/generated/**",
    "**/outputs/**",
    "**/work/**",
    "**/.cache/**",
    "**/.wrangler/**",
    "**/.codex-dev-*.log",
  ];

  return {
    server: {
      watch: {
        ignored: ignoredRuntimeArtifacts,
        ...(isCodexSeatbeltSandbox
          ? { useFsEvents: false, usePolling: true }
          : {}),
      },
    },
    plugins: [
      svelte(),
      vinext(),
      sites(),
      ...cloudflarePlugins,
    ],
  };
});
