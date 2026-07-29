import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

const title = "MandelHowl — Resonance Volume Instrument";
const description =
  "Turn one frequency dial. A deterministic Chladni plate and feedback loop decide whether the volume decays, howls, or balances at the edge.";

const baseMetadata: Metadata = {
  title: {
    default: title,
    template: "%s · MandelHowl",
  },
  description,
  applicationName: "MandelHowl",
  keywords: [
    "MandelHowl",
    "Chladni plate",
    "acoustic feedback",
    "resonance",
    "interactive experiment",
  ],
};

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const rawHost =
    requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host");
  const host = rawHost?.split(",")[0]?.trim();
  const safeHost =
    host && /^[a-z0-9.-]+(?::\d+)?$/i.test(host) ? host : null;

  if (!safeHost) {
    return baseMetadata;
  }

  const forwardedProtocol = requestHeaders
    .get("x-forwarded-proto")
    ?.split(",")[0]
    ?.trim();
  const localHost =
    safeHost.startsWith("localhost") || safeHost.startsWith("127.0.0.1");
  const protocol =
    localHost && forwardedProtocol !== "https" ? "http" : "https";
  const socialImage = `${protocol}://${safeHost}/og.png`;

  return {
    ...baseMetadata,
    openGraph: {
      type: "website",
      siteName: "MandelHowl",
      title,
      description,
      images: [
        {
          url: socialImage,
          width: 1_740,
          height: 907,
          alt: "MandelHowl acoustic feedback instrument with a frequency dial, Chladni plate, microphone and virtual volume meter.",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [socialImage],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
