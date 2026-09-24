import assert from "node:assert/strict";
import test from "node:test";
import { createIntl } from "react-intl";

import { mergedMessages } from "../src/i18n/messages";
import {
  formatAttachmentUploadClientError,
  formatAttachmentUploadServerError,
} from "../src/utils/attachmentUploadErrorPresentation";
import { AttachmentUploadClientError } from "../src/utils/directAttachmentUpload";

test("upload stall and storage-timeout reasons resolve through the active locale", () => {
  const zh = createIntl({ locale: "zh-cn", messages: mergedMessages("zh-cn") }).formatMessage;

  assert.equal(
    formatAttachmentUploadClientError(
      new AttachmentUploadClientError("UPLOAD_STALLED", "Attachment upload stalled", true),
      zh,
    ),
    "上传已停止传输。请检查网络连接后重试。",
  );
  assert.equal(
    formatAttachmentUploadServerError("Attachment storage timed out", zh),
    "文件已传到 Raft，但保存超时。",
  );
  assert.equal(
    formatAttachmentUploadServerError("A future server reason", zh),
    "A future server reason",
    "unknown server reasons must remain precise instead of collapsing to a generic error",
  );
});
