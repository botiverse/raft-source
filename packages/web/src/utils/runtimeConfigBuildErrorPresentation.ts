import type { IntlShape } from "react-intl";

import { RUNTIME_CONFIG_BUILD_ERROR_MESSAGE_ID } from "./runtimeConfigForm";
import type { RuntimeConfigBuildError } from "./runtimeConfigForm";

export function formatRuntimeConfigBuildError(
  error: RuntimeConfigBuildError,
  formatMessage: IntlShape["formatMessage"],
): string {
  const id = RUNTIME_CONFIG_BUILD_ERROR_MESSAGE_ID[error.code];
  return formatMessage({ id });
}
