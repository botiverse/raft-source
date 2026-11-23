// Platform entry point: the server's one limit on concurrent sharp image
// decodes (lib/imageDecodeLimit.ts). Every module that runs sharp, core or
// app, goes through it, so an app's renders (Artifacts' OG cards) share the
// process's decode budget instead of adding their own.
export { withImageDecodeSlot } from "../lib/imageDecodeLimit";
