// Module-scope env read used by the B1 ordering tooth: the value this module
// observes is frozen at FIRST evaluation. Imported only AFTER bootstrap.
export const observedSentinel = process.env.B1_ORDER_SENTINEL ?? "(unset)";
