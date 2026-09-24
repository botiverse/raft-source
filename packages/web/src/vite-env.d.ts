/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  readonly VITE_DEPLOYMENT_ENV?: string;
  readonly VITE_PREVIEW_BRANCH?: string;
  readonly VITE_PREVIEW_API_TARGET?: string;
  readonly VITE_COMMIT_SHA?: string;
  readonly VITE_APP_VERSION?: string;
  readonly VITE_BUILD_AT?: string;
  readonly VITE_RELEASE_BRANCH?: string;
  readonly VITE_FRONTEND_RELEASE_ID?: string;
  readonly VITE_ENABLE_SHARE_TO_X?: string;
  readonly VITE_ENABLE_REACT_SCAN?: string;
  readonly VITE_FEEDBACK_EXPORT_URL?: string;
  readonly VITE_SLOCKDEV_ENV_NAME?: string;
  readonly VITE_SLOCKDEV_EMAIL?: string;
  readonly VITE_SLOCKDEV_PREVIEW_DESCRIPTION?: string;
}
