// A font file imported by the Worker is a Data module (wrangler.jsonc's rules): its bytes.
declare module "*.woff2" {
  const bytes: ArrayBuffer;
  export default bytes;
}
