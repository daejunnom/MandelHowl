import { createRoot } from "react-dom/client";

import { MandelHowlLab } from "../app/mandelhowl-lab";
import "../app/globals.css";

window.__MANDELHOWL_DATASET_URL__ = new URL(
  "runtime/manifest.json",
  document.baseURI,
).href;

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("MandelHowl root element is missing.");
}

createRoot(rootElement).render(<MandelHowlLab />);
