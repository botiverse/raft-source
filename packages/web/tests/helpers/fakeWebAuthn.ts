// A stand-in for the browser's WebAuthn (PublicKeyCredential and
// navigator.credentials) for passkey behavior tests. jsdom has neither, so a
// test without this sees a browser that can't use passkeys.

type CredentialCall = { options: CredentialRequestOptions | CredentialCreationOptions };

export interface FakeWebAuthn {
  gets: CredentialRequestOptions[];
  creates: CredentialCreationOptions[];
  restore: () => void;
}

type Answer = (call: CredentialCall) => unknown;

/** The JSON a browser's toJSON() gives for an assertion with credential `id`. */
export function assertionJSON(id = "cred-1") {
  return {
    id,
    rawId: id,
    type: "public-key",
    clientExtensionResults: {},
    response: { clientDataJSON: "Y2xpZW50", authenticatorData: "YXV0aA", signature: "c2ln" },
  };
}

/** The JSON a browser's toJSON() gives for a new passkey with credential `id`. */
export function registrationJSON(id = "cred-new") {
  return {
    id,
    rawId: id,
    type: "public-key",
    clientExtensionResults: {},
    response: { clientDataJSON: "Y2xpZW50", attestationObject: "YXR0", transports: ["internal"] },
  };
}

/** A credential the fake browser hands back: only toJSON() is read. */
export function credentialFor(json: { id: string }) {
  return { id: json.id, toJSON: () => json };
}

/** The person closed the browser's prompt. */
export function closedPrompt(): DOMException {
  return new DOMException("The operation either timed out or was not allowed.", "NotAllowedError");
}

/**
 * Installs the fake. `get` / `create` answer each call (throw to refuse);
 * `autofill`: whether conditional mediation is available. A conditional
 * request with no answer of its own (`pendingAutofill`) stays pending until
 * aborted, like a real browser's autofill that nobody picks from.
 */
export function installFakeWebAuthn({
  get,
  create,
  autofill = false,
  pendingAutofill = true,
}: {
  get?: Answer;
  create?: Answer;
  autofill?: boolean;
  pendingAutofill?: boolean;
} = {}): FakeWebAuthn {
  const gets: CredentialRequestOptions[] = [];
  const creates: CredentialCreationOptions[] = [];
  class FakePublicKeyCredential {
    static async isConditionalMediationAvailable() {
      return autofill;
    }
  }
  const globals = globalThis as { PublicKeyCredential?: unknown };
  const previousCtor = globals.PublicKeyCredential;
  const previousCredentials = Object.getOwnPropertyDescriptor(globalThis.navigator, "credentials");
  globals.PublicKeyCredential = FakePublicKeyCredential;
  Object.defineProperty(globalThis.navigator, "credentials", {
    configurable: true,
    value: {
      get: async (options: CredentialRequestOptions) => {
        gets.push(options);
        if (options.mediation === "conditional" && pendingAutofill) {
          return new Promise((_resolve, reject) => {
            options.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
          });
        }
        if (!get) throw closedPrompt();
        return get({ options });
      },
      create: async (options: CredentialCreationOptions) => {
        creates.push(options);
        if (!create) throw closedPrompt();
        return create({ options });
      },
    },
  });
  return {
    gets,
    creates,
    restore: () => {
      globals.PublicKeyCredential = previousCtor;
      if (previousCredentials) Object.defineProperty(globalThis.navigator, "credentials", previousCredentials);
      else delete (globalThis.navigator as { credentials?: unknown }).credentials;
    },
  };
}
