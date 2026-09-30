// pyworker.js - runs student code with Pyodide (Python compiled to WebAssembly)
// in a separate thread, so the page can terminate it if a test runs too long.
import { loadPyodide } from "../vendor/pyodide/pyodide.mjs";

let runTest = null, syntaxCheck = null, pyodide = null;

try {
  const [py, harness] = await Promise.all([
    loadPyodide({ indexURL: new URL("../vendor/pyodide/", import.meta.url).href }),
    fetch(new URL("harness.py", import.meta.url)).then((r) => r.text()),
  ]);
  py.runPython(harness);
  pyodide = py;
  runTest = py.globals.get("run_test");
  syntaxCheck = py.globals.get("syntax_check");
  postMessage({ type: "ready", version: py.version });
} catch (err) {
  postMessage({ type: "failed", error: String(err) });
}

onmessage = async (e) => {
  const { id, kind, code, stdin, capture, packages } = e.data;
  try {
    let result;
    if (kind === "prepare") {
      // load extra packages (e.g. matplotlib) once, outside the timed tests
      await pyodide.loadPackage(packages);
      if (packages.includes("matplotlib")) {
        pyodide.runPython("import matplotlib\nmatplotlib.use('Agg')\nimport matplotlib.pyplot");
      }
      result = true;
    } else if (kind === "syntax") {
      result = syntaxCheck(code) ?? null;
    } else {
      const r = runTest(code, stdin, !!capture);
      result = r.toJs();
      r.destroy();
    }
    postMessage({ id, ok: true, result });
  } catch (err) {
    // e.g. the JavaScript stack overflowing on very deep recursion
    postMessage({ id, ok: false, error: String(err) });
  }
};
