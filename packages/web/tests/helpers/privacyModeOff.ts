// The page holds telemetry until the client config says whether privacy mode
// is on (src/store/privacyMode.ts). Tests that are not about privacy mode run
// as a deployment that answered "off"; tests/privacyMode.test.ts resets it.
import { setPrivacyMode } from "../../src/store/privacyMode";

setPrivacyMode(false);
