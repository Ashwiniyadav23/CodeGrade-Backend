import 'dotenv/config'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { pipeline } from 'stream/promises'
import mongoose from 'mongoose'
import { uploadCloudinaryAsset } from '../src/cloudinaryStorage.js'

const sourceUri = process.env.SOURCE_MONGO_URI || process.env.MONGO_URI
const targetUri = process.env.TARGET_MONGO_URI
if (!sourceUri || !targetUri) throw new Error('Set SOURCE_MONGO_URI and TARGET_MONGO_URI. The source cluster is read-only; only the empty target is written.')
const sourceAddress = new URL(sourceUri)
const targetAddress = new URL(targetUri)
if (sourceAddress.host.toLowerCase() === targetAddress.host.toLowerCase()) throw new Error('Source and target must be different MongoDB clusters.')

const batchSize = 100
const maxTargetBytes = 450 * 1024 * 1024
const gridFsBuckets = ['submissions', 'starters'] as const
const gridFsCollections = new Set(gridFsBuckets.flatMap(bucket => [`${bucket}.files`, `${bucket}.chunks`]))
const assetUrls = new Map<string, string>()

async function uploadGridFsFiles(sourceDb: any, tempDir: string) {
  for (const bucketName of gridFsBuckets) {
    const files = sourceDb.collection(`${bucketName}.files`)
    if (!await sourceDb.listCollections({ name: `${bucketName}.files` }).hasNext()) continue
    const bucket = new mongoose.mongo.GridFSBucket(sourceDb, { bucketName })
    for await (const file of files.find({})) {
      const localPath = path.join(tempDir, `${bucketName}-${String(file._id)}.bin`)
      await pipeline(bucket.openDownloadStream(file._id), fs.createWriteStream(localPath))
      const sourceExt = path.extname(String(file.filename || '')) || '.bin'
      const url = await uploadCloudinaryAsset(localPath, `codegrade/migrated/${bucketName}`, `${String(file._id)}${sourceExt}`)
      assetUrls.set(`${bucketName}:${String(file._id)}`, url)
      await fs.promises.unlink(localPath)
      console.log(`Moved ${bucketName} file ${String(file._id)} (${file.length} bytes) to Cloudinary.`)
    }
  }
}

function transformDocument(collectionName: string, doc: any) {
  const copy = { ...doc }
  if (collectionName === 'submissions') {
    if (copy.file_id) {
      const url = assetUrls.get(`submissions:${String(copy.file_id)}`)
      if (!url) throw new Error(`Missing Cloudinary copy for submission GridFS id ${String(copy.file_id)}.`)
      copy.cloudinary_url = url
      delete copy.file_id
    }
  }
  if (collectionName === 'assessments' && typeof copy.starter_url === 'string' && copy.starter_url.startsWith('gridfs:')) {
    const fileId = copy.starter_url.slice('gridfs:'.length)
    const url = assetUrls.get(`starters:${fileId}`)
    if (!url) throw new Error(`Missing Cloudinary copy for starter GridFS id ${fileId}.`)
    copy.starter_url = url
  }
  if (collectionName === 'submissions' && Array.isArray(copy.code_files) && copy.code_files.length) {
    const payload = Buffer.from(JSON.stringify(copy.code_files))
    const id = String(copy._id)
    copy.code_files_url = '' // replaced asynchronously by the caller
    return { copy, workspacePayload: payload, workspaceId: id }
  }
  if (collectionName === 'submissions' && Array.isArray(copy.code_files)) delete copy.code_files
  return { copy }
}

async function copyIndexes(sourceDb: any, targetDb: any, collectionName: string) {
  const sourceCollection = sourceDb.collection(collectionName)
  const targetCollection = targetDb.collection(collectionName)
  for (const index of await sourceCollection.listIndexes().toArray()) {
    if (index.name === '_id_') continue
    const options: Record<string, any> = {}
    for (const [key, value] of Object.entries(index)) {
      if (!['key', 'name', 'ns', 'v'].includes(key)) options[key] = value
    }
    await targetCollection.createIndex(index.key, options)
  }
}

async function main() {
  const source = await mongoose.createConnection(sourceUri!).asPromise()
  const target = await mongoose.createConnection(targetUri!).asPromise()
  const sourceDb = source.db!
  const targetDb = target.db!
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'codegrade-migrate-'))
  try {
    const existingTargetCollections = (await targetDb.listCollections({}, { nameOnly: true }).toArray())
      .map((collection: any) => collection.name).filter((name: string) => !name.startsWith('system.'))
    if (existingTargetCollections.length) {
      throw new Error(`Target database ${targetDb.databaseName} must be empty. Found: ${existingTargetCollections.join(', ')}`)
    }

    console.log(`Reading source database ${sourceDb.databaseName}; target is ${targetDb.databaseName}. Source will not be modified.`)
    await uploadGridFsFiles(sourceDb, tempDir)

    for (const asset of assetUrls.entries()) {
      const [key, url] = asset
      const [bucket, fileId] = key.split(':')
      const file = await sourceDb.collection(`${bucket}.files`).findOne({ _id: new mongoose.Types.ObjectId(fileId) })
      if (!file) throw new Error(`GridFS metadata disappeared for ${key}.`)
      await targetDb.collection('codegrade_migration_assets').insertOne({
        source_bucket: bucket,
        source_file_id: file._id,
        filename: file.filename,
        length: file.length,
        upload_date: file.uploadDate,
        metadata: file.metadata,
        cloudinary_url: url,
      })
    }

    const collectionNames = (await sourceDb.listCollections({}, { nameOnly: true }).toArray())
      .map((collection: any) => collection.name)
      .filter((name: string) => !name.startsWith('system.') && !gridFsCollections.has(name))

    for (const collectionName of collectionNames) {
      const sourceCollection = sourceDb.collection(collectionName)
      const targetCollection = targetDb.collection(collectionName)
      let batch: any[] = []
      for await (const doc of sourceCollection.find({})) {
        const transformed = transformDocument(collectionName, doc)
        if (transformed.workspacePayload && transformed.workspaceId) {
          const workspacePath = path.join(tempDir, `${transformed.workspaceId}.json`)
          await fs.promises.writeFile(workspacePath, transformed.workspacePayload)
          transformed.copy.code_files_url = await uploadCloudinaryAsset(workspacePath, 'codegrade/migrated/workspaces', `${transformed.workspaceId}.json`)
          await fs.promises.unlink(workspacePath)
          delete transformed.copy.code_files
        }
        batch.push(transformed.copy)
        if (batch.length >= batchSize) {
          await targetCollection.insertMany(batch, { ordered: true })
          batch = []
        }
      }
      if (batch.length) await targetCollection.insertMany(batch, { ordered: true })
      await copyIndexes(sourceDb, targetDb, collectionName)
      console.log(`Copied ${collectionName}.`)
    }

    const stats = await targetDb.stats()
    const usedBytes = Number(stats.dataSize || 0) + Number(stats.indexSize || 0)
    console.log(`Target data + indexes: ${(usedBytes / (1024 * 1024)).toFixed(1)} MiB.`)
    if (usedBytes >= maxTargetBytes) {
      throw new Error('The migrated database is too close to the Free tier limit (450 MiB safety ceiling). The source remains unchanged; do not switch the app to this target.')
    }
    console.log('Migration copy completed. Verify logins, assessments, submission downloads, and evaluations before changing the app MONGO_URI. Keep the source cluster intact as rollback.')
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true })
    await Promise.all([source.close(), target.close()])
  }
}

main().catch(error => {
  console.error('Free-tier migration did not complete:', error?.message || error)
  process.exitCode = 1
})
