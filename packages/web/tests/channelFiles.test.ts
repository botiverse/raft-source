import assert from "node:assert/strict";
import test from "node:test";
import { formatChannelFileSize, getChannelFileType } from "../src/utils/channelFiles";
import type { ChannelFileLike } from "../src/utils/channelFiles";
import { en } from "../src/i18n/messages/en";
import type { MessageId } from "../src/i18n/messages";

function file(partial: Partial<ChannelFileLike> & Pick<ChannelFileLike, "filename" | "mimeType">): ChannelFileLike {
  return {
    filename: partial.filename,
    mimeType: partial.mimeType,
  };
}

function formatMessage(
  descriptor: { id: MessageId },
  values?: Record<string, string | number | boolean | null | undefined>,
): string {
  const template = en[descriptor.id];
  if (!values) return template;
  return template.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? ""));
}

test("getChannelFileType classifies v0 file badges from mime type and filename", () => {
  assert.equal(getChannelFileType(file({ filename: "shot.png", mimeType: "image/png" })), "image");
  assert.equal(getChannelFileType(file({ filename: "clip.mov", mimeType: "video/quicktime" })), "video");
  assert.equal(getChannelFileType(file({ filename: "paper.bin", mimeType: "application/pdf" })), "pdf");
  assert.equal(getChannelFileType(file({ filename: "bundle.zip", mimeType: "application/octet-stream" })), "archive");
  assert.equal(getChannelFileType(file({ filename: "notes.txt", mimeType: "text/plain" })), "other");
});

test("formatChannelFileSize uses compact binary units", () => {
  assert.equal(formatChannelFileSize(0, formatMessage), "0 B");
  assert.equal(formatChannelFileSize(512, formatMessage), "512 B");
  assert.equal(formatChannelFileSize(1536, formatMessage), "1.5 KB");
  assert.equal(formatChannelFileSize(5 * 1024 * 1024, formatMessage), "5.0 MB");
});
