import pc from "picocolors";
import { build } from "esbuild";
import { readFileSync, statSync } from "node:fs";
const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf-8"));

const outfile = "dist/index.js";

try {
    await build({
        entryPoints: ["src/index.ts"],
        outfile,
        bundle: true,
        platform: "node",
        format: "esm",
        // jsonpath-plus requires Node 22
        target: "node22",
        sourcemap: "external",
        minify: true,
        logLevel: "warning",
        // Bundled CommonJS dependencies call require() for Node built-ins,
        // which ESM output does not provide on its own.
        banner: {
            js: 'import { createRequire as __preaurCreateRequire } from "node:module"; const require = __preaurCreateRequire(import.meta.url);',
        },
        define: {
            VERSION: JSON.stringify(`${version}_bundled`),
        },
    });

    console.log(`${pc.green("Build successful!")} Artifacts:`);
    for (const path of [outfile, `${outfile}.map`]) {
        const readableSize = (statSync(path).size / 1024).toFixed(2) + " KiB";
        console.log(`    ${pc.blue(path)} ${pc.gray(readableSize)}`);
    }
} catch {
    // esbuild has already printed the errors.
    console.error("Build failed.");
    process.exitCode = 1;
}
