type MicromarkExtension = {
  disable?: {
    null?: string[];
  };
};

type RemarkProcessor = {
  data(key: "micromarkExtensions"): MicromarkExtension[] | undefined;
  data(key: "micromarkExtensions", value: MicromarkExtension[]): unknown;
};

/**
 * Compact chat surfaces require an explicit fence for block code. This keeps
 * ordinary four-space-indented message text from becoming an accidental
 * CommonMark code block while leaving fenced code and list continuation
 * parsing intact.
 */
export function remarkDisableIndentedCode(this: RemarkProcessor): void {
  const micromarkExtensions = this.data("micromarkExtensions") ?? [];
  this.data("micromarkExtensions", [
    ...micromarkExtensions,
    { disable: { null: ["codeIndented"] } },
  ]);
}
