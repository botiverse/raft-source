import { createMemoryContinuationStore } from "./memoryStore";
import { continuationStoreContract } from "./store.testkit";

continuationStoreContract("memory", () => createMemoryContinuationStore());
