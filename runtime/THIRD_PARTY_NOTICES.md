# Third-party notices

MandelHowl includes or is built with the following principal open-source
projects. Their complete license texts remain available in their respective
distributions and source repositories.

| Project | Purpose | License |
|---|---|---|
| React and React DOM | User interface runtime | MIT |
| Next.js | Application framework compatibility | MIT |
| Vite | Development and build tooling | MIT |
| vinext | Next.js-compatible Vite runtime | MIT |
| Tailwind CSS and PostCSS | CSS build tooling | MIT |
| Vitest | Unit testing | MIT |
| ESLint and eslint-config-next | Static analysis | MIT |
| Cloudflare Vite plugin and Wrangler | Cloudflare Workers build/development tooling | Apache-2.0 or MIT as declared by each package |
| TypeScript and React type definitions | Type checking | Apache-2.0 or MIT as declared by each package |

The generated MandelHowl physics dataset contains no third-party photographs,
recordings, meshes, or pretrained model output. It is derived deterministically
from the repository's plate specification by `tools/physics-baker`.

The release also includes
`release/third-party-license-inventory.json`, generated from the pinned
`package-lock.json`. It lists every non-link transitive package, version, SPDX
license expression, integrity value, and dev/optional/peer classification.
Upstream distributions remain the canonical source of complete license texts.
