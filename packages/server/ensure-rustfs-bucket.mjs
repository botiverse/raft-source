// Used by scripts/dev/raftdev.ts ensureRustfsBucket. Invoked as
// `npx tsx ensure-rustfs-bucket.mjs` with cwd=packages/server so ESM
// resolution can find @aws-sdk/client-s3 via the monorepo's node_modules.
//
// Lives as a real file (not an inline `tsx --eval` payload) because on
// Windows the spawnSync({ shell: true }) + array-args path concats args
// without quoting (Node DEP0190), and cmd.exe then chops a multi-line
// --eval body into separate batch statements — leaving tsx with empty
// eval input and exiting 0 without ever running the script.
import { CreateBucketCommand, HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";

void (async () => {
  const client = new S3Client({
    endpoint: process.env.S3_ENDPOINT,
    region: process.env.S3_REGION || "us-east-1",
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
    },
  });
  const bucket = process.env.S3_ATTACHMENTS_BUCKET;
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch (err) {
    const status = err?.$metadata?.httpStatusCode;
    const name = err?.name;
    if (status === 404 || name === "NotFound" || name === "NoSuchBucket") {
      await client.send(new CreateBucketCommand({ Bucket: bucket }));
    } else {
      throw err;
    }
  }
})();
