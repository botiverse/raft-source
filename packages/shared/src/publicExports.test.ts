import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageRoot, "../..");
const packageName = "@botiverse/raft-shared";

const expectedExports = {
  "./announcement-audience": {
    types: "./announcement-audience.ts",
    default: "./announcement-audience.ts",
  },
  "./announcement-priority": {
    types: "./src/announcementPriority.ts",
    default: "./src/announcementPriority.ts",
  },
  "./announcement-presentation": {
    types: "./announcement-presentation.ts",
    default: "./announcement-presentation.ts",
  },
  ".": {
    types: "./src/index.ts",
    default: "./src/index.ts",
  },
  "./feature-flag-admin-privileges": {
    types: "./feature-flag-admin-privileges.ts",
    default: "./feature-flag-admin-privileges.ts",
  },
  "./feature-flag-client-rules": {
    types: "./feature-flag-client-rules.ts",
    default: "./feature-flag-client-rules.ts",
  },
  "./feature-flag-taxonomy": {
    types: "./feature-flag-taxonomy.ts",
    default: "./feature-flag-taxonomy.ts",
  },
  "./feature-flag-taxonomy-internal": {
    types: "./feature-flag-taxonomy-internal.ts",
    default: "./feature-flag-taxonomy-internal.ts",
  },
  "./src/agentApiChannelJoin": {
    types: "./src/agentApiChannelJoin.ts",
    default: "./src/agentApiChannelJoin.ts",
  },
  "./src/agentApiClient": {
    types: "./src/agentApiClient.ts",
    default: "./src/agentApiClient.ts",
  },
  "./src/selfExec": {
    types: "./src/selfExec.ts",
    default: "./src/selfExec.ts",
  },
  // The SDK's ./app subpath reads ServerId without loading the root (and its agent chunk).
  "./src/brandedIds": {
    types: "./src/brandedIds.ts",
    default: "./src/brandedIds.ts",
  },
  "./src/displayLocales": {
    types: "./src/displayLocales.ts",
    default: "./src/displayLocales.ts",
  },
  // The web's Settings search reads its index without loading the root.
  "./src/settingsSearch": {
    types: "./src/settingsSearch.ts",
    default: "./src/settingsSearch.ts",
  },
  // Raft Desktop's main process applies the Raft home rule without loading the root.
  "./src/agentOps/raftHome": {
    types: "./src/agentOps/raftHome.ts",
    default: "./src/agentOps/raftHome.ts",
  },
  // Raft Desktop's main process validates outside routes without loading the root.
  "./src/desktopRoutes": {
    types: "./src/desktopRoutes.ts",
    default: "./src/desktopRoutes.ts",
  },
  // Raft Desktop's main process checks notification routes and window attention without loading the root.
  "./src/desktopNotifications": {
    types: "./src/desktopNotifications.ts",
    default: "./src/desktopNotifications.ts",
  },
  // Raft Desktop's main process checks external-link schemes without loading the root.
  "./src/externalLinkSchemes": {
    types: "./src/externalLinkSchemes.ts",
    default: "./src/externalLinkSchemes.ts",
  },
  "./src/sameSite": {
    types: "./src/sameSite.ts",
    default: "./src/sameSite.ts",
  },
  // Raft Desktop's main process refuses Raft's own hosts in the web preview view without loading the root.
  "./src/raftPermalinks": {
    types: "./src/raftPermalinks.ts",
    default: "./src/raftPermalinks.ts",
  },
  "./src/feedbackSubmit": {
    types: "./src/feedbackSubmit.ts",
    default: "./src/feedbackSubmit.ts",
  },
  "./src/agentApiContract": {
    types: "./src/agentApiContract.ts",
    default: "./src/agentApiContract.ts",
  },
  "./src/agentApiMessageContract": {
    types: "./src/agentApiMessageContract.ts",
    default: "./src/agentApiMessageContract.ts",
  },
  "./src/agentApiMessages": {
    types: "./src/agentApiMessages.ts",
    default: "./src/agentApiMessages.ts",
  },
  "./src/agentApiRawClient": {
    types: "./src/agentApiRawClient.ts",
    default: "./src/agentApiRawClient.ts",
  },
  "./src/agentApiRouteMeta": {
    types: "./src/agentApiRouteMeta.ts",
    default: "./src/agentApiRouteMeta.ts",
  },
  "./src/agentCliSurface": {
    types: "./src/agentCliSurface.ts",
    default: "./src/agentCliSurface.ts",
  },
  "./src/agentMessageText": {
    types: "./src/agentMessageText.ts",
    default: "./src/agentMessageText.ts",
  },
  "./src/agentMigrationBundleReader": {
    types: "./src/agentMigrationBundleReader.ts",
    default: "./src/agentMigrationBundleReader.ts",
  },
  "./src/agentOps/hint.testkit": {
    types: "./src/agentOps/hint.testkit.ts",
    default: "./src/agentOps/hint.testkit.ts",
  },
  "./src/agentOps/index": {
    types: "./src/agentOps/index.ts",
    default: "./src/agentOps/index.ts",
  },
  "./src/integrations/index": {
    types: "./src/integrations/index.ts",
    default: "./src/integrations/index.ts",
  },
  "./src/agentOps/seenPolicy/index": {
    types: "./src/agentOps/seenPolicy/index.ts",
    default: "./src/agentOps/seenPolicy/index.ts",
  },
  "./src/agentText/index": {
    types: "./src/agentText/index.ts",
    default: "./src/agentText/index.ts",
  },
  "./src/agentText/continuations": {
    types: "./src/agentText/continuations.ts",
    default: "./src/agentText/continuations.ts",
  },
  "./src/continuations/index": {
    types: "./src/continuations/index.ts",
    default: "./src/continuations/index.ts",
  },
  "./src/continuations/store.testkit": {
    types: "./src/continuations/store.testkit.ts",
    default: "./src/continuations/store.testkit.ts",
  },
  "./src/generated/agentApiRoutes": {
    types: "./src/generated/agentApiRoutes.ts",
    default: "./src/generated/agentApiRoutes.ts",
  },
  "./src/appObjectKey": {
    types: "./src/appObjectKey.ts",
    default: "./src/appObjectKey.ts",
  },
  "./src/artifactContentTicket": {
    types: "./src/artifactContentTicket.ts",
    default: "./src/artifactContentTicket.ts",
  },
  // The content Worker reads a file's kind and its page's path without loading the root.
  "./src/artifactFiles": {
    types: "./src/artifactFiles.ts",
    default: "./src/artifactFiles.ts",
  },
  // The content Worker's Markdown page and config read their colours without loading the root.
  "./src/artifactPageTheme": {
    types: "./src/artifactPageTheme.ts",
    default: "./src/artifactPageTheme.ts",
  },
  // And what the page's calls run under, for the same three sides.
  "./src/artifactCheckContract": {
    types: "./src/artifactCheckContract.ts",
    default: "./src/artifactCheckContract.ts",
  },
  "./src/appConfigTransport": {
    types: "./src/appConfigTransport.ts",
    default: "./src/appConfigTransport.ts",
  },
  "./src/appLinkPreview": {
    types: "./src/appLinkPreview.ts",
    default: "./src/appLinkPreview.ts",
  },
  "./src/appRuntimeTrace": {
    types: "./src/appRuntimeTrace.ts",
    default: "./src/appRuntimeTrace.ts",
  },
  "./src/apps/cleaner/configProtocol": {
    types: "./src/apps/cleaner/configProtocol.ts",
    default: "./src/apps/cleaner/configProtocol.ts",
  },
  "./src/apps/reminder/protocol": {
    types: "./src/apps/reminder/protocol.ts",
    default: "./src/apps/reminder/protocol.ts",
  },
  "./src/attachmentUploadContract": {
    types: "./src/attachmentUploadContract.ts",
    default: "./src/attachmentUploadContract.ts",
  },
  "./src/tracing/index": {
    types: "./src/tracing/index.ts",
    default: "./src/tracing/index.ts",
  },
  "./src/tracing/eventRows": {
    types: "./src/tracing/eventRows.ts",
    default: "./src/tracing/eventRows.ts",
  },
  "./src/clock": {
    types: "./src/clock.ts",
    default: "./src/clock.ts",
  },
  "./src/noProxy": {
    types: "./src/noProxy.ts",
    default: "./src/noProxy.ts",
  },
  "./src/traceUploadUrl": {
    types: "./src/traceUploadUrl.ts",
    default: "./src/traceUploadUrl.ts",
  },
  "./src/pixelAvatarGenerator": {
    types: "./src/pixelAvatarGenerator.ts",
    default: "./src/pixelAvatarGenerator.ts",
  },
  "./src/humanAvatar": {
    types: "./src/humanAvatar.ts",
    default: "./src/humanAvatar.ts",
  },
  "./src/humanAvatarArt": {
    types: "./src/humanAvatarArt.ts",
    default: "./src/humanAvatarArt.ts",
  },
  "./src/generated/openapi": {
    types: "./src/generated/openapi.ts",
    default: "./src/generated/openapi.ts",
  },
  "./src/testVectors/messageRepliesDiscussionGraph.vectors.json":
    "./src/testVectors/messageRepliesDiscussionGraph.vectors.json",
  "./src/testVectors/threadRepliesReadModel.vectors.json":
    "./src/testVectors/threadRepliesReadModel.vectors.json",
  "./src/testVectors/appObjectKeys.vectors.json":
    "./src/testVectors/appObjectKeys.vectors.json",
  "./assets/pixelAvatars.json": "./assets/pixelAvatars.json",
  "./assets/humanAvatarLayers.json": "./assets/humanAvatarLayers.json",
  "./src/settingsSearch.v1.json": "./src/settingsSearch.v1.json",
  "./package.json": "./package.json",
} as const;

type ExportValue = string | { types: string; default: string };

interface ImportUse {
  file: string;
  specifier: string;
}

function trackedSourceFiles(): string[] {
  return execFileSync("git", ["-C", repoRoot, "ls-files", "-z"], {
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean)
    .filter((file) => [".cjs", ".cts", ".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx"].includes(extname(file)));
}

function scriptKind(file: string): ts.ScriptKind {
  if (file.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (file.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (file.endsWith(".js") || file.endsWith(".mjs") || file.endsWith(".cjs")) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function sharedImportUses(): ImportUse[] {
  const uses: ImportUse[] = [];

  for (const relativeFile of trackedSourceFiles()) {
    const file = join(repoRoot, relativeFile);
    const sourceFile = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      scriptKind(file),
    );

    const record = (literal: ts.StringLiteralLike | undefined): void => {
      const specifier = literal?.text;
      if (specifier === packageName || specifier?.startsWith(`${packageName}/`)) {
        uses.push({ file, specifier });
      }
    };

    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        record(node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier) ? node.moduleSpecifier : undefined);
      } else if (ts.isImportEqualsDeclaration(node)) {
        const reference = node.moduleReference;
        if (ts.isExternalModuleReference(reference)) {
          record(reference.expression && ts.isStringLiteralLike(reference.expression) ? reference.expression : undefined);
        }
      } else if (ts.isImportTypeNode(node)) {
        const argument = node.argument;
        if (ts.isLiteralTypeNode(argument)) {
          record(ts.isStringLiteralLike(argument.literal) ? argument.literal : undefined);
        }
      } else if (
        ts.isCallExpression(node)
        && node.arguments.length === 1
        && ts.isStringLiteralLike(node.arguments[0])
        && (node.expression.kind === ts.SyntaxKind.ImportKeyword
          || (ts.isIdentifier(node.expression) && node.expression.text === "require"))
      ) {
        record(node.arguments[0]);
      }
      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
  }

  return uses;
}

function exportKey(specifier: string): string {
  return specifier === packageName ? "." : `.${specifier.slice(packageName.length)}`;
}

function targetFor(value: ExportValue): string {
  return typeof value === "string" ? value : value.default;
}

function resolvedTarget(value: ExportValue): string {
  return realpathSync(join(packageRoot, targetFor(value)));
}

const trackedUses = sharedImportUses();

test("public exports preserve every tracked raft-shared consumer", (context) => {
  const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
    exports?: unknown;
    files?: unknown;
    sideEffects?: unknown;
  };
  assert.deepEqual(packageJson.exports, expectedExports);
  assert.equal(packageJson.files, undefined, "public entry points must not silently change the packed-file list");
  assert.equal(packageJson.sideEffects, undefined, "public entry points must not assert an unaudited side-effect contract");
  assert.equal(Object.keys(expectedExports).some((key) => key.includes("*")), false, "wildcard exports would reopen internal paths");

  assert.ok(trackedUses.length > 0, "expected tracked raft-shared consumers");
  const rootUseCount = trackedUses.filter(({ specifier }) => specifier === packageName).length;
  const publicLeafUseCount = trackedUses.filter(
    ({ specifier }) => specifier === `${packageName}/feature-flag-admin-privileges`,
  ).length;
  context.annotate(
    `${trackedUses.length} imports in ${new Set(trackedUses.map(({ file }) => file)).size} tracked files; `
      + `${rootUseCount} root, ${publicLeafUseCount} public leaf, `
      + `${trackedUses.length - rootUseCount - publicLeafUseCount} compatibility deep imports; `
      + `${new Set(trackedUses.map(({ specifier }) => specifier)).size} package entry points`,
  );

  const missing = trackedUses.filter(({ specifier }) => !(exportKey(specifier) in expectedExports));
  assert.deepEqual(
    missing.map(({ file, specifier }) => `${specifier} in ${relative(repoRoot, file)}`),
    [],
    "every tracked consumer must resolve through an explicit public or compatibility export",
  );

  for (const [key, value] of Object.entries(expectedExports)) {
    assert.doesNotThrow(
      () => resolvedTarget(value),
      `${key} must target a real file`,
    );
  }
});

test("continuations, their runtime and their agent text, stay off the package root", async () => {
  const root = await import("./index");
  for (const name of ["formatContinuationPaused", "formatContinuationRefusal", "formatContinuationSpan", "parseContinuationId", "CONTINUATION_FORMAT_VERSION"]) {
    assert.equal(name in root, false, `${name} is exported from the package root`);
  }
});

test("Node resolves root, public leaf, and current deep imports to the declared files", () => {
  const representativeBySpecifier = new Map<string, string>();
  for (const use of trackedUses) representativeBySpecifier.set(use.specifier, use.file);

  for (const [specifier, importer] of representativeBySpecifier) {
    const key = exportKey(specifier) as keyof typeof expectedExports;
    const expected = resolvedTarget(expectedExports[key]);
    const requireResolved = realpathSync(createRequire(pathToFileURL(importer)).resolve(specifier));
    const importResolved = realpathSync(fileURLToPath(import.meta.resolve(specifier)));
    assert.equal(requireResolved, expected, `require.resolve: ${specifier} from ${importer}`);
    assert.equal(importResolved, expected, `import.meta.resolve: ${specifier}`);
  }

  const representative = trackedUses[0]?.file;
  assert.ok(representative, "expected a representative raft-shared importer");
  assert.throws(
    () => createRequire(pathToFileURL(representative)).resolve(`${packageName}/src/index.js`),
    (error: unknown) => {
      assert.equal((error as NodeJS.ErrnoException).code, "ERR_PACKAGE_PATH_NOT_EXPORTED");
      return true;
    },
  );
  assert.throws(
    () => import.meta.resolve(`${packageName}/src/index.js`),
    (error: unknown) => {
      assert.equal((error as NodeJS.ErrnoException).code, "ERR_PACKAGE_PATH_NOT_EXPORTED");
      return true;
    },
  );
});

test("TypeScript consumer modes resolve every tracked import through the same targets", () => {
  const modes = [
    ["Bundler", ts.ModuleResolutionKind.Bundler, ts.ModuleKind.ESNext],
    ["Node16", ts.ModuleResolutionKind.Node16, ts.ModuleKind.Node16],
    ["NodeNext", ts.ModuleResolutionKind.NodeNext, ts.ModuleKind.NodeNext],
  ] as const;

  for (const [label, moduleResolution, module] of modes) {
    for (const { file, specifier } of trackedUses) {
      const result = ts.resolveModuleName(
        specifier,
        file,
        {
          allowJs: true,
          module,
          moduleResolution,
          resolveJsonModule: true,
        },
        ts.sys,
      ).resolvedModule;
      assert.ok(result, `${label} must resolve ${specifier} from ${file}`);
      const key = exportKey(specifier) as keyof typeof expectedExports;
      assert.equal(realpathSync(result.resolvedFileName), resolvedTarget(expectedExports[key]), `${label}: ${specifier} from ${file}`);
    }
  }
});
