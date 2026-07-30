export const SECURITY_HEADERS_POLICY = `/*
  Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; media-src 'self' blob:; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'self'
  Cross-Origin-Opener-Policy: same-origin
  Permissions-Policy: camera=(), geolocation=(), microphone=(), payment=(), usb=()
  Referrer-Policy: no-referrer
  X-Content-Type-Options: nosniff
  X-Frame-Options: SAMEORIGIN

/runtime/*
  Cache-Control: public, max-age=31536000, immutable

/runtime/manifest.json
  Cache-Control: no-cache, max-age=0, must-revalidate

/runtime/release-provenance.json
  Cache-Control: no-cache, max-age=0, must-revalidate
`;

export function assertSecurityHeadersPolicy(source) {
  if (source !== SECURITY_HEADERS_POLICY) {
    throw new Error(
      "Security headers differ from the exact release policy.",
    );
  }
  return Object.freeze({
    contentSecurityPolicy: "closed-self-origin",
    permissions: Object.freeze({
      camera: false,
      geolocation: false,
      microphone: false,
      payment: false,
      usb: false,
    }),
    immutableRuntimeAssets: true,
    mutableManifestAndProvenance: true,
  });
}
