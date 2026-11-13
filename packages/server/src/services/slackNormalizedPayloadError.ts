/** A single normalized payload has a malformed envelope; its raw receipt remains authoritative. */
export class SlackNormalizedEnvelopeInvalid extends Error {
  constructor() {
    super("Slack normalized payload envelope is invalid");
    this.name = "SlackNormalizedEnvelopeInvalid";
  }
}
