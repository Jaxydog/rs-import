declare module "rs-import:*.rs" {
    const ffi: Record<string, any>;

    export default ffi;
}

declare module "rs-import:*/Cargo.toml" {
    const ffi: Record<string, any>;

    export default ffi;
}
