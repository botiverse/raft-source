plugins {
    kotlin("multiplatform") version "2.1.21"
    kotlin("plugin.serialization") version "2.1.21"
}

kotlin {
    jvm()

    // Single source of truth: compile the CANONICAL generated binding rather
    // than a copy inside the canary. The copy previously drifted to a voided
    // digest and still carried the @JvmInline construct that breaks the OHOS
    // target, while nothing in CI compiled it.
    sourceSets {
        val commonMain by getting {
            // Both generated files live here; the canary keeps no copies.
            kotlin.srcDir("../generated/bindings")
            dependencies {
                implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.6.2")
            }
        }
        val commonTest by getting {
            dependencies {
                implementation(kotlin("test"))
            }
        }
    }
}

tasks.withType<Test>().configureEach {
    useJUnitPlatform()
}
