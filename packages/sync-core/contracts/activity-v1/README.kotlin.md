# Activity TypeSpec direct Kotlin packet v1

The Kotlin leg of the Activity contract.

**Digests are NOT transcribed here.** `manifest.json` holds them authoritatively
and `tools/verify-contract.mjs` pins the manifest against the real files. An
earlier version of this README listed source/generator/binding SHAs by hand;
they silently expired as the contract evolved and ended up pointing at a voided
binding, which is worse than no README because it sends a reader to compare
against dead values and then doubt the artifacts.


`tools/generate-kotlin.mjs` reads the TypeSpec compiler semantic graph
directly. JSON Schema and OpenAPI are not generator inputs. It emits:

- sealed `kotlinx.serialization` unions with `type` discriminators;
- required/null/optional distinctions, including a non-null optional wrapper;
- strict unknown-field decoding;
- a constrained decimal-string serializer derived from the TypeSpec
  `UInt64String` contract;
- exact fixture bytes and their digests as common-test source.

The isolated KMP/JVM canary under `canary/` runs the frozen 13 vectors and the
seven-ingress fixture seed. It passed with Kotlin `2.1.21` and
`kotlinx-serialization-json 1.6.2`:

```text
compileKotlinJvm PASS
compileTestKotlinJvm PASS
jvmTest PASS
```

The same generated binding also passed Mobile
`:shared:compileDebugKotlinAndroid` from fresh `origin/main`. Full Mobile unit
test compilation hit a VM Gradle daemon disappearance after main compilation;
the isolated canary is the focused local runtime receipt and Hosted CI remains
required for the repository-wide gate.

This packet does not fabricate a reducer result digest. The behavior seed has
no expected reducer output, so `canonicalBehaviorResultSha256` and activation
remain null until both real reducers consume the same immutable vector.
