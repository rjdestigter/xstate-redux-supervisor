import * as React from "react";
import { render } from "react-dom";

import App from "./App";

const rootElement = document.getElementById("root");
render(<App />, rootElement);

if (process.env.NODE_ENV === "development") {
  (async function() {
    const reactPckg = await import(/* webpackChunkName: "package-versions" */
    "react/package.json");

    const reactDomPckg = await import(/* webpackChunkName: "package-versions" */
    "react-dom/package.json");

    console.group("Package Versions");
    console.info("react: %s", reactPckg.version);
    console.info("react-dom: %s", reactDomPckg.version);
    console.groupEnd();
  })();
}
