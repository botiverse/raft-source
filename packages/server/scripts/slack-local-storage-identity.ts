/** Run only after an operator verifies the configured local storage volume. */
import fs from "node:fs";
import path from "node:path";
import { initializeLocalStoragePresenceIdentity } from "../src/services/storageService";

const [action, option, directory, expectedOption, expectedObjectKey, ...extra] = process.argv.slice(2);
if (action !== "initialize" || option !== "--directory" || !directory
  || expectedOption !== "--expect-object" || !expectedObjectKey || extra.length) {
  throw new Error("Usage: slack-local-storage-identity.ts initialize --directory /verified/storage/volume --expect-object known/attachment/key");
}
const configuredDirectory = process.env.UPLOADS_DIR;
console.info("Local storage initialization directory:", fs.realpathSync(path.resolve(directory)));
console.info("Configured UPLOADS_DIR:", configuredDirectory ? fs.realpathSync(path.resolve(configuredDirectory)) : "unset");
console.log(initializeLocalStoragePresenceIdentity({ directory, configuredDirectory, expectedObjectKey }));
