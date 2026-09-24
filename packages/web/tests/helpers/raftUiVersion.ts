/**
 * The one place the expected raft-ui version is written down.
 *
 * Two separate guards assert this pin, which is deliberate — they protect
 * different things (the CSS/provider wiring, and the Drawer shell). What is NOT
 * deliberate is writing the literal twice: a bump then updates one and leaves
 * the other red, and that failure does not look like "a pin is stale". It looks
 * like the migration didn't take or the package didn't install, which is
 * precisely the class of misreading that cost this team two days.
 *
 * Bump this constant WITH the dependency. The guards exist so that a raft-ui
 * upgrade is a visible, reviewed act rather than silent lockfile drift.
 */
export const EXPECTED_RAFT_UI_VERSION = "0.5.11";
