import { dest, src, watch } from "gulp";
import esbuild from "gulp-esbuild";
import { createProject } from "gulp-typescript";
import { goodReporter } from "./typescript";
import { pipeline } from "stream/promises";

import chromiumVersion from "./chromium-version.json";

const tsProject = createProject("src/view/tsconfig.json");

export function compileViewEsbuild() {
  // ! Switched to pipeline to see correct build error
  // ! See update to merge into this: https://github.com/github/vscode-codeql/pull/4009#issue-3010866136

  /*
  [19:25:54] 'compileViewEsbuild' errored after 1.53 s
  [19:25:54] Error in plugin "gulp-esbuild"
  Message:
      Build failed with 2 errors:
  src/common/logging/vscode/output-channel-logger.ts:2:33: ERROR: Could not resolve "vscode"
  src/config.ts:7:66: ERROR: Could not resolve "vscode"
  [19:25:54] 'default' errored after 1.55 s
  */

  // ! Above error can be resolved by adding `external: ["vscode"]` to esbuild options below
  // ! But this will cause the webview to not display, so need other solution

  return pipeline(
    src("./src/view/webview.tsx"),
    esbuild({
      outfile: "webview.js",
      bundle: true,
      format: "iife",
      platform: "browser",
      target: `chrome${chromiumVersion.chromiumVersion}`,
      jsx: "automatic",
      sourcemap: "linked",
      sourceRoot: "..",
      loader: {
        ".ttf": "file",
      },
    }),
    dest("out"),
  );
}

export function watchViewEsbuild() {
  watch(["src/**/*.{ts,tsx}"], compileViewEsbuild);
}

export function checkViewTypeScript() {
  // This doesn't actually output the TypeScript files, it just
  // runs the TypeScript compiler and reports any errors.
  return tsProject.src().pipe(tsProject(goodReporter()));
}

export function watchViewCheckTypeScript() {
  watch(["src/**/*.{ts,tsx}"], checkViewTypeScript);
}
