import { BunPlugin, PluginBuilder } from "bun";
import { FFIFunction, Library, Narrow, dlopen, suffix } from "bun:ffi";
import { exists, mkdir, readFile, readdir, rename, rm, writeFile } from "fs/promises";

const namespace = "rs-import";
const module_definitions = `declare module "rs-import:*.rs" {
    const ffi: Record<string, any>;

    export default ffi;
}

declare module "rs-import:*/Cargo.toml" {
    const ffi: Record<string, any>;

    export default ffi;
}
`;

export interface ImportMetadata {
    type: "cargo" | "rustc";
    name: string;
    slug: string;
    path: string;
    file_path: string;
    hash_path: string;
}
export interface ImportPath {
    type: "rustc" | "cargo",
    name: string;
    path: string;
    cdylib: string;
    hash: string;
};

export interface RSManifestEntry {
    [exposed: string]: Narrow<FFIFunction>;
}

export interface RSManifest {
    [library: string]: RSManifestEntry | undefined;
}

export interface RSConfig {
    import?: {
        manifest?: string;
        always_recompile?: boolean;
    };
    build?: {
        output_dir?: string;
        rustc_args?: string[];
        cargo_args?: string[];
    };
}

export default function rsimport(): BunPlugin {
    return {
        name: namespace,
        target: "bun",

        async setup(build: PluginBuilder): Promise<void> {
            const cwd = process.cwd();
            const config = await rsconfig(cwd);
            const manifest = await rsmanifest(cwd, config);

            const output_dir = config.build?.output_dir ?? "build";
            const config_hash_path = `${output_dir}/__rsconfig.hash`;
            const config_changed = !await check_config_hash(config, config_hash_path);

            await writeFile(`${cwd}/rs-import.d.ts`, module_definitions, { encoding: "utf-8" });

            for (const key in manifest) {
                const path = `${cwd}/${key}`;
                const metadata = await resolve_import_metadata(cwd, output_dir, path);

                if (!await check_import_hash(metadata) || config_changed || config.import?.always_recompile) {
                    await compile_library(config, metadata);
                }
            }

            build.onResolve({ filter: /./, namespace }, async ({ importer, path }) => {
                const resolved = import.meta.resolveSync(path, importer);

                return { path: resolved, namespace }
            });

            build.onLoad({ filter: /./, namespace }, async ({ path }) => {
                const metadata = await resolve_import_metadata(cwd, output_dir, path);
                const library = await import_library(cwd, manifest, metadata);

                return { exports: { default: library.symbols, ...library.symbols }, loader: "object" };
            });
        }
    };
}

async function rsconfig(cwd: string): Promise<RSConfig> {
    try {
        return (await import(`${cwd}/rsconfig.json`)).default;
    } catch {
        return {};
    }
}
async function rsmanifest(cwd: string, rsconfig: RSConfig): Promise<RSManifest> {
    const path = `${cwd}/${rsconfig.import?.manifest ?? "rsmanifest.json"}`;

    try {
        return (await import(path)).default;
    } catch {
        return {};
    }
}

async function resolve_import_metadata(cwd: string, output_dir: string, path: string): Promise<ImportMetadata> {
    const type = path.endsWith("Cargo.toml") ? "cargo" : "rustc";
    const name = type === "cargo" ? await resolve_cargo_name(path) : resolve_rustc_name(path);
    const slug = `${type}/${path.replace(`${cwd}/`, "").replaceAll(/(?:\.rs)|(?:\/Cargo.toml)/g, "")}`;

    const file_path = `${cwd}/${output_dir}/libs/${slug}/lib${name}.${suffix}`;
    const hash_path = `${cwd}/${output_dir}/hash/${slug}/${name}.hash`;

    return { type, name, slug, path, file_path, hash_path };
}
async function resolve_cargo_name(path: string): Promise<string> {
    const crate = (await import(path))?.default;
    const name = crate?.package?.name as string | undefined;

    if (name === undefined) throw new Error("Unable to parse `Cargo.toml` import");

    return name;
}
function resolve_rustc_name(path: string): string {
    const name = path.match(/\w+?(?=\.rs$)/)?.[0];

    if (name === undefined) throw new Error("Unable to parse `rustc` import path");

    return name;
}

async function hash_file(path: string): Promise<[string]> {
    if (!await exists(path)) throw new Error("The file could not be found");

    return [Bun.hash(await readFile(path)).toString()];
}
async function hash_directory(path: string, ignore: string[] = [], recurse = true): Promise<string[]> {
    if (ignore.includes(path)) return [];

    const folder = await readdir(path, { withFileTypes: true });
    const hashes: string[] = [];

    for (const entry of folder) {
        const filepath = `${path}/${entry.name}`;

        if (entry.isFile()) {
            hashes.push(...await hash_file(filepath));
        } else if (entry.isDirectory() && recurse) {
            hashes.push(...await hash_directory(filepath, ignore));
        }
    }

    return hashes;
}
async function hash_import(metadata: ImportMetadata): Promise<string[]> {
    if (metadata.type === "cargo") {
        const directory = metadata.path.replace(/\/Cargo\.toml$/, "");

        return await hash_directory(directory, [`${directory}/target`], true);
    } else {
        return await hash_file(metadata.path);
    }
}
async function check_import_hash(metadata: ImportMetadata): Promise<boolean> {
    const hash = JSON.stringify(await hash_import(metadata));

    async function write_hash(path: string, hash: string): Promise<void> {
        const directory = path.replace(/\w+?\.\w+?$/, "");

        await mkdir(directory, { recursive: true });
        await writeFile(path, hash, { encoding: "utf-8" });
    }

    if (!await exists(metadata.hash_path)) {
        await write_hash(metadata.hash_path, hash);

        return false;
    }

    const saved = await readFile(metadata.hash_path, { encoding: "utf-8" });

    if (saved !== hash) {
        await write_hash(metadata.hash_path, hash);

        return false;
    }

    return true;
}
async function check_config_hash(config: RSConfig, path: string): Promise<boolean> {
    const hash = JSON.stringify(config);

    async function write_hash(path: string, hash: string): Promise<void> {
        const directory = path.replace(/\w+?\.\w+?$/, "");

        await mkdir(directory, { recursive: true });
        await writeFile(path, hash, { encoding: "utf-8" });
    }

    if (!await exists(path)) {
        await write_hash(path, hash);

        return false;
    }

    const saved = await readFile(path, { encoding: "utf-8" });

    if (saved !== hash) {
        await write_hash(path, hash);

        return false;
    }

    return true;
}

async function compile_library(config: RSConfig, metadata: ImportMetadata): Promise<void> {
    const directory = metadata.file_path.replace(/\/\w+?\.\w+?$/, "");

    await mkdir(directory, { recursive: true });
    await rm(metadata.file_path, { force: true });

    if (metadata.type === "cargo") {
        if (!Bun.which("cargo")) throw new Error("The `cargo` utility must be installed");

        const file_path = `${metadata.path.replace(/\/Cargo\.toml$/, "")}/target/release/lib${metadata.name}.${suffix}`;
        const args = [
            "-r",
            `--manifest-path=${metadata.path}`,
            ...(config.build?.cargo_args ?? [])
        ];

        if (await Bun.spawn(["cargo", "b", ...args]).exited !== 0) throw new Error("Compilation failed!");

        await rename(file_path, metadata.file_path);
    } else {
        if (!Bun.which("rustc")) throw new Error("The `rustc` compiler must be installed");

        const args = [
            "--crate-type=cdylib",
            "--emit=link",
            `--out-dir=${metadata.file_path.replace(/\/\w+?\.\w+?$/, "")}`,
            ...(config.build?.rustc_args ?? [])
        ];

        if (await Bun.spawn(["rustc", ...args, metadata.path]).exited !== 0) throw new Error("Compilation failed");
    }
}
async function import_library(cwd: string, manifest: RSManifest, metadata: ImportMetadata): Promise<Library<RSManifestEntry>> {
    const key = metadata.path.replace(`${cwd}/`, "");
    const data = manifest[key];

    if (data === undefined) throw new Error(`Missing manifest entry for '${key}'`);

    return dlopen(metadata.file_path, data);
}
