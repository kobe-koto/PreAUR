import pc from "picocolors";
import { readFileSync } from "node:fs";
const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf-8"));

const result = await Bun.build({
    entrypoints: ["./src/index.ts"],
    outdir: "./dist",
    target: "bun",
    sourcemap: "external",
    minify: true,
    define: {
        VERSION: JSON.stringify(`${version}_bundled`),
    },
});

if (result.success) {
    console.log(`${pc.green("Build successful!")} Artifacts:`);
    result.outputs.map(output => {
        const readableSize = (output.size / 1024).toFixed(2) + " KiB";
        console.log(`    ${pc.blue(output.path)} ${pc.gray(readableSize)}`);
    })
} else {
    console.error("Build failed:");
    console.error(result.logs.map(log => log.message).join("\n"));
}
