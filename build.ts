import { copyFile } from "fs/promises";
import { JsxEmit, ModuleDetectionKind, ModuleKind, ModuleResolutionKind, ScriptTarget, createProgram, formatDiagnosticsWithColorAndContext, getPreEmitDiagnostics, sys } from "typescript";

const output_dir = "dist";
const entrypoint = "./src/index.ts";

console.info("Bundling...");

const output = await Bun.build({
    entrypoints: [entrypoint],
    outdir: output_dir,
    target: "bun",
    format: "esm",
    splitting: true,
    sourcemap: "external",
    minify: true,
    root: "./src"
});

if (!output.success) {
    console.error(output.logs);

    throw new Error("Bundling failed");
}

console.info("Generating type definitions...");

const program = createProgram({
    rootNames: [entrypoint],
    options: {
        lib: ["ESNext"],
        module: ModuleKind.ESNext,
        target: ScriptTarget.ESNext,
        moduleResolution: ModuleResolutionKind.Bundler,
        moduleDetection: ModuleDetectionKind.Force,
        allowImportingTsExtensions: true,
        strict: true,
        downlevelIteration: true,
        skipLibCheck: true,
        jsx: JsxEmit.Preserve,
        allowSyntheticDefaultImports: true,
        forceConsistentCasingInFileNames: true,
        allowJs: true,
        types: ["bun-types"],
        declaration: true,
        declarationDir: `./${output_dir}`,
        emitDeclarationOnly: true,
    },
});

const diagnostics = getPreEmitDiagnostics(program).concat(program.emit().diagnostics);

if (diagnostics.length > 0) {
    console.error(formatDiagnosticsWithColorAndContext(diagnostics, {
        getCurrentDirectory: sys.getCurrentDirectory,
        getNewLine: () => sys.newLine,
        getCanonicalFileName: sys.useCaseSensitiveFileNames ? (fileName: string) => fileName : (fileName: string) => fileName.toLowerCase(),
    }));
}

console.info("Copying files...");

await copyFile("README.md", `${output_dir}/README.md`);
await copyFile("LICENSE", `${output_dir}/LICENSE`);
await copyFile("package.json", `${output_dir}/package.json`);

console.info("Bundling finished");