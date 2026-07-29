import { notFound } from "next/navigation";
import { AudioSafetyFixture } from "./audio-safety-fixture";

export default function AudioSafetyFixturePage() {
  if (process.env.NODE_ENV === "production") {
    notFound();
  }
  return <AudioSafetyFixture />;
}
