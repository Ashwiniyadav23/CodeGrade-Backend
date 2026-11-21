# Preserve data while moving to Atlas Free

Atlas has blocked writes on the current M0 cluster because it is over its storage limit. This migration copies all application collections into a new, empty M0 cluster, uploads legacy submission files and workspaces to the configured Cloudinary account, and leaves the existing cluster unchanged as a rollback copy.

Atlas allows one Free cluster per project, so create the target M0 in a **new Atlas project**. Do not delete or modify the existing cluster. Free clusters do not provide Atlas backups; this procedure keeps the source cluster intact.

## Before running

1. Create a new Atlas project and an empty M0 cluster. Create a database user and allow the migration machine's IP in Network Access.
2. Ensure Cloudinary credentials point to the account already used by this app. The account must have enough space for the existing files.
3. Keep writes to the app paused during the copy, so the source does not change while records are being transferred. The source is only read by this script.
4. In `CodeGrade-Backend`, set `SOURCE_MONGO_URI` to the existing cluster URI and `TARGET_MONGO_URI` to the new cluster URI in the local `.env`. Keep `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, and `CLOUDINARY_API_SECRET` configured. Do not commit or share these values.

## Run the copy

From this backend directory:

```sh
npx tsx scripts/migrate-free-cluster.ts
```

The script refuses a target database that is not empty and checks that the copied data and indexes stay below a 450 MiB safety ceiling. It preserves document IDs and all application records, and moves old GridFS uploads and inline workspace files to Cloudinary. It does not delete source records, users, submissions, or files.

If the script stops after partially filling the target, leave the source alone and create another empty M0 database/project before retrying. The script will not overwrite a partially populated target. Some Cloudinary objects from an interrupted attempt may remain; the source data remains intact.

## Switch only after verification

Before changing the deployed `MONGO_URI`, verify the copied document counts, user login, assessments, submission downloads, workspace source, and evaluations against the new cluster. Then set the backend deployment's `MONGO_URI` to the target URI and resume writes. Keep the old cluster intact until the new deployment has been confirmed. Do not run the script against the production target more than once.

The data-size check is a conservative guard, not a guarantee of future headroom: keep new source uploads in Cloudinary as the app already does and monitor Atlas storage after switching.
