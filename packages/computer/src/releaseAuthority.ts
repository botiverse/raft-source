// Public Hands authority shared by release selection and read-only discovery.
// Keep this leaf module free of updater/service dependencies so CLI discovery
// does not pull the K release graph into its presenter.
export const HANDS_COMPUTER_APP_SLUG = "raft-computer-cli";
export const HANDS_API_ORIGIN = "https://hands.build";
