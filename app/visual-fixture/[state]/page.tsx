import { notFound } from "next/navigation";
import { MandelHowlVisualFixture } from "../visual-fixture";

export default async function VisualFixturePage({
  params,
}: {
  params: Promise<{ state: string }>;
}) {
  if (process.env.NODE_ENV === "production") {
    notFound();
  }
  const { state } = await params;
  return <MandelHowlVisualFixture stateName={state} />;
}
