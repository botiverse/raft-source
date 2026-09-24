package build.raft.app.network.sync.activity.contract.v1

import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertContains
import kotlin.test.assertEquals
import kotlin.test.assertFails
import kotlin.test.assertIs
import kotlin.test.assertTrue

class ActivitySyncContractCanaryTest {
    private val json = ActivitySyncContractJson.strict

    @Test
    fun directKotlinBindingEnforcesAllFrozenContractVectors() {
        val vectors = ACTIVITY_SYNC_CONTRACT_VECTORS_JSONL
            .lineSequence()
            .filter(String::isNotBlank)
            .map { line -> json.decodeFromString(ContractVectorEnvelope.serializer(), line) }
            .toList()

        assertEquals(18, vectors.size)
        assertEquals(4, vectors.count { it.constraintClass == ConstraintClass.Positive })
        assertEquals(10, vectors.count { it.constraintClass == ConstraintClass.Structural })
        assertEquals(4, vectors.count { it.constraintClass == ConstraintClass.ValueDomain })

        vectors.forEach { vector ->
            // Gate B1: the frozen vectors span TWO contract domains — ActivityIngress
            // (snapshot/difference/frame/...) and ActivityIntent (the Done intents
            // markThreadDone/markInboxDone carrying throughActivitySeq). Dispatch the
            // runtime codec by the candidate's discriminator so the I1-I5 intent
            // vectors are enforced against ActivityIntent, not mis-fed to
            // ActivityIngress (which would wrongly reject the I5 positive).
            val decoded = runCatching {
                if (isIntentCandidate(vector.candidate)) {
                    json.decodeFromJsonElement(ActivityIntent.serializer(), vector.candidate)
                } else {
                    json.decodeFromJsonElement(ActivityIngress.serializer(), vector.candidate)
                }
            }
            when (vector.expectation.kotlinRuntime) {
                ContractVerdict.Accept -> assertTrue(
                    decoded.isSuccess,
                    "${vector.vectorId} must decode but failed with ${decoded.exceptionOrNull()}",
                )
                ContractVerdict.Reject -> assertTrue(
                    decoded.isFailure,
                    "${vector.vectorId} must be rejected by the generated Kotlin runtime codec",
                )
                ContractVerdict.Exempt -> error(
                    "Kotlin runtime cannot exempt a frozen Activity vector: ${vector.vectorId}",
                )
            }
        }

        val beyondSafeInteger = decodeCandidate(vectors.single { it.vectorId == "P2-beyond-js-safe-integer" })
        val snapshot = assertIs<SnapshotIngress>(beyondSafeInteger)
        assertEquals("9007199254740993", snapshot.watermark.value)
        assertEquals("9007199254740993", snapshot.activityVersion.value)
        val encoded = json.encodeToString(ActivityIngress.serializer(), snapshot)
        assertContains(encoded, "\"watermark\":\"9007199254740993\"")
        assertContains(encoded, "\"activityVersion\":\"9007199254740993\"")

        val requiredNull = assertIs<DifferenceIngress>(
            decodeCandidate(vectors.single { it.vectorId == "P3-required-null-present" }),
        )
        assertEquals(null, requiredNull.nextFromSeq)
    }

    @Test
    fun optionalNonNullableKeepsMissingDistinctFromExplicitNull() {
        val missing = json.decodeFromString(InboxQuery.serializer(), "{}")
        assertEquals(OptionalField.Missing, missing.cursor)

        assertFails {
            json.decodeFromString(InboxQuery.serializer(), "{\"cursor\":null}")
        }
    }

    @Test
    fun v1NumericConstraintsAreEnforcedByTheGeneratedRuntimeCodec() {
        fun admitted(authoritySeq: String): V1AdmittedResponse = json.decodeFromString(
            V1AdmittedResponse.serializer(),
            """{"code":"pending","status":"admitted","outcome":"unknown","mutationId":"mutation-1","authoritySeq":$authoritySeq,"frontierUrl":"/frontier/mutation-1"}""",
        )

        assertEquals(0L, admitted("0").authoritySeq)
        assertEquals(9_007_199_254_740_991L, admitted("9007199254740991").authoritySeq)
        assertFails { admitted("-1") }
        assertFails { admitted("9007199254740992") }

        val accepted = json.decodeFromString(
            V1MarkInboxReadAllResponse.serializer(),
            """{"ok":true,"markedCount":0,"scopes":[]}""",
        )
        assertEquals(0, accepted.markedCount)
        assertFails {
            json.decodeFromString(
                V1MarkInboxReadAllResponse.serializer(),
                """{"ok":true,"markedCount":-1,"scopes":[]}""",
            )
        }
    }

    @Test
    fun v1PendingResponsesDecodeWithoutACommittedPrimaryOutcome() {
        val readAll = json.decodeFromString(
            V1AdmittedResponse.serializer(),
            """{"code":"pending","status":"admitted","outcome":"unknown","mutationId":"mutation-read","authoritySeq":7,"frontierUrl":"/frontier/mutation-read"}""",
        )
        assertEquals(7L, readAll.authoritySeq)

        val done = json.decodeFromString(
            V1AdmittedResponse.serializer(),
            """{"code":"pending","status":"admitted","outcome":"unknown","mutationId":"mutation-done","authoritySeq":8,"frontierUrl":"/frontier/mutation-done"}""",
        )
        assertEquals(8L, done.authoritySeq)

        for (mutationId in listOf("mutation-read", "mutation-done")) {
            assertFails {
                json.decodeFromString(
                    V1AdmittedResponse.serializer(),
                    """{"code":"pending","status":"admitted","outcome":"unknown","primaryOutcome":"committed","mutationId":"$mutationId","authoritySeq":8,"frontierUrl":"/frontier/$mutationId"}""",
                )
            }
        }
    }

    @Test
    fun immutableFixtureSeedDecodesAllSevenIngressBranchesAndRoundTrips() {
        assertEquals(
            // This asserts ONLY that the generated constant is a well-formed
            // 64-char digest. It does NOT compare against manifest.json — the
            // Kotlin canary has no manifest reader, and claiming otherwise
            // would be a comment describing work the code does not do.
            // Manifest equality is enforced repo-side by
            // tools/verify-contract.mjs, which pins the manifest against the
            // real generated files.
            64,
            ACTIVITY_SYNC_TYPESPEC_SHA256.length,
        )
        val envelope = json.decodeFromString(
            ActivityFixtureEnvelope.serializer(),
            ACTIVITY_SYNC_BEHAVIOR_SEED_JSONL.trim(),
        )
        val ingresses = envelope.steps
            .filterIsInstance<IngestFixtureStep>()
            .map(IngestFixtureStep::ingress)

        assertEquals(7, ingresses.size)
        assertEquals(
            listOf(
                "snapshot",
                "notModified",
                "difference",
                "frame",
                "commandReceipt",
                "commandRejected",
                "readStateUpdated",
            ),
            ingresses.map(::ingressKind),
        )

        ingresses.forEach { ingress ->
            val encoded = json.encodeToString(ActivityIngress.serializer(), ingress)
            val decoded = json.decodeFromString(ActivityIngress.serializer(), encoded)
            assertEquals(ingress, decoded)
        }
    }

    private fun decodeCandidate(vector: ContractVectorEnvelope): ActivityIngress =
        json.decodeFromJsonElement(ActivityIngress.serializer(), vector.candidate)

    private val intentTypes = setOf(
        "ensureWindow",
        "refresh",
        "loadMore",
        "markChannelReadAll",
        "markInboxReadAll",
        "markThreadDone",
        "markInboxDone",
    )

    private fun isIntentCandidate(candidate: kotlinx.serialization.json.JsonElement): Boolean {
        val type = candidate.jsonObject["type"]?.jsonPrimitive?.content
        return type in intentTypes
    }

    private fun ingressKind(ingress: ActivityIngress): String = when (ingress) {
        is SnapshotIngress -> "snapshot"
        is NotModifiedIngress -> "notModified"
        is DifferenceIngress -> "difference"
        is FrameIngress -> "frame"
        is CommandReceiptIngress -> "commandReceipt"
        is CommandRejectedIngress -> "commandRejected"
        is ReadStateUpdatedIngress -> "readStateUpdated"
    }
}
