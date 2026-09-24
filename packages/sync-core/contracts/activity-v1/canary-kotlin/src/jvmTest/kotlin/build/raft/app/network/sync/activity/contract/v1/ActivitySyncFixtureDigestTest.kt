package build.raft.app.network.sync.activity.contract.v1

import java.security.MessageDigest
import kotlin.test.Test
import kotlin.test.assertEquals

class ActivitySyncFixtureDigestTest {
    @Test
    fun generatedFixtureBytesMatchIndependentRawFileReceipts() {
        val vectorsDigest = sha256(rawFileBytes(ACTIVITY_SYNC_CONTRACT_VECTORS_JSONL))
        val seedDigest = sha256(rawFileBytes(ACTIVITY_SYNC_BEHAVIOR_SEED_JSONL))

        assertEquals(
            "89ef866cc5e16dd321945c422e5f9ae7919157312d4bafbc68e9241d6ae3bee3",
            vectorsDigest,
        )
        assertEquals(
            "90b2b32ec7bd73575df3977ed7e62dcbf4a833e164d29813f28e65a619b29100",
            seedDigest,
        )
        assertEquals(vectorsDigest, ACTIVITY_SYNC_CONTRACT_VECTORS_SHA256)
        assertEquals(seedDigest, ACTIVITY_SYNC_BEHAVIOR_SEED_SHA256)
    }

    private fun rawFileBytes(generatedLiteral: String): ByteArray =
        "${generatedLiteral.trimIndent()}\n".encodeToByteArray()

    private fun sha256(input: ByteArray): String =
        MessageDigest.getInstance("SHA-256")
            .digest(input)
            .joinToString("") { byte -> "%02x".format(byte) }
}
