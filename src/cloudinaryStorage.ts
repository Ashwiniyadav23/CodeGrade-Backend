import { v2 as cloudinary } from 'cloudinary'
import fs from 'fs'
import path from 'path'

const MAX_RAW_ASSET_BYTES = 9 * 1024 * 1024
const CHUNK_MANIFEST_PREFIX = 'cloudinary-manifest:'
const configured = () => !!(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET)

function requireCloudinary() {
  if (!configured()) throw new Error('Cloudinary is not configured. Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET before accepting uploads.')
  cloudinary.config({ cloud_name: process.env.CLOUDINARY_CLOUD_NAME, api_key: process.env.CLOUDINARY_API_KEY, api_secret: process.env.CLOUDINARY_API_SECRET })
}

function uploadRawFile(filePath: string, folder: string, publicId: string): Promise<string> {
  requireCloudinary()
  const extension = path.extname(filePath) || '.bin'
  const filename = `${path.basename(publicId, path.extname(publicId))}${extension}`
  return new Promise((resolve, reject) => {
    cloudinary.uploader.upload(filePath, { resource_type: 'raw', folder, public_id: filename, overwrite: true },
      (err, result) => err ? reject(err) : resolve(result!.secure_url))
  })
}

export function uploadCloudinaryBuffer(buffer: Buffer, folder: string, filename: string): Promise<string> {
  requireCloudinary()
  return new Promise((resolve, reject) => {
    const upload = cloudinary.uploader.upload_stream({ resource_type: 'raw', folder, public_id: filename, overwrite: true },
      (err, result) => err ? reject(err) : resolve(result!.secure_url))
    upload.end(buffer)
  })
}

export async function uploadCloudinaryAsset(filePath: string, folder: string, publicId: string): Promise<string> {
  const size = fs.statSync(filePath).size
  if (size <= MAX_RAW_ASSET_BYTES) return uploadRawFile(filePath, folder, publicId)

  const data = fs.readFileSync(filePath)
  const baseId = path.basename(publicId, path.extname(publicId))
  const chunkUrls: string[] = []
  for (let offset = 0, index = 0; offset < data.length; offset += MAX_RAW_ASSET_BYTES, index++) {
    const chunk = data.subarray(offset, Math.min(offset + MAX_RAW_ASSET_BYTES, data.length))
    const chunkName = `${baseId}.part-${String(index + 1).padStart(3, '0')}.bin`
    chunkUrls.push(await uploadCloudinaryBuffer(chunk, `${folder}/parts`, chunkName))
  }

  const manifest = Buffer.from(JSON.stringify({ format: 'codegrade-cloudinary-chunks-v1', chunks: chunkUrls }))
  const manifestUrl = await uploadCloudinaryBuffer(manifest, `${folder}/manifests`, `${baseId}.manifest.json`)
  return `${CHUNK_MANIFEST_PREFIX}${manifestUrl}`
}

function assertOwnedCloudinaryUrl(assetUrl: string) {
  const url = new URL(assetUrl)
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME
  const prefix = `/${cloudName}/raw/upload/`
  if (!cloudName || url.protocol !== 'https:' || url.hostname !== 'res.cloudinary.com' || !url.pathname.includes(prefix)) {
    throw new Error('Invalid Cloudinary asset URL.')
  }
  return url
}

function publicIdFromUrl(assetUrl: string) {
  const url = assertOwnedCloudinaryUrl(assetUrl)
  const prefix = `/${process.env.CLOUDINARY_CLOUD_NAME}/raw/upload/`
  let publicId = url.pathname.slice(url.pathname.indexOf(prefix) + prefix.length)
  publicId = publicId.replace(/^v\d+\//, '')
  return decodeURIComponent(publicId)
}

async function fetchAsset(assetUrl: string) {
  assertOwnedCloudinaryUrl(assetUrl)
  const response = await fetch(assetUrl)
  if (!response.ok) throw new Error(`Cloudinary asset download returned HTTP ${response.status}.`)
  return Buffer.from(await response.arrayBuffer())
}

export async function downloadCloudinaryAsset(assetUrl: string): Promise<Buffer> {
  if (!assetUrl.startsWith(CHUNK_MANIFEST_PREFIX)) return fetchAsset(assetUrl)
  const manifestUrl = assetUrl.slice(CHUNK_MANIFEST_PREFIX.length)
  const manifestBuffer = await fetchAsset(manifestUrl)
  const manifest = JSON.parse(manifestBuffer.toString('utf8'))
  if (manifest?.format !== 'codegrade-cloudinary-chunks-v1' || !Array.isArray(manifest.chunks) || !manifest.chunks.length || manifest.chunks.length > 16) {
    throw new Error('Cloudinary upload manifest is invalid.')
  }
  const chunks = await Promise.all(manifest.chunks.map((url: unknown) => {
    if (typeof url !== 'string') throw new Error('Cloudinary upload manifest contains an invalid chunk URL.')
    return fetchAsset(url)
  }))
  return Buffer.concat(chunks)
}

export async function deleteCloudinaryAsset(assetUrl: string) {
  try {
    requireCloudinary()
    const urls = [assetUrl]
    if (assetUrl.startsWith(CHUNK_MANIFEST_PREFIX)) {
      const manifestUrl = assetUrl.slice(CHUNK_MANIFEST_PREFIX.length)
      const manifest = JSON.parse((await fetchAsset(manifestUrl)).toString('utf8'))
      if (manifest?.format === 'codegrade-cloudinary-chunks-v1' && Array.isArray(manifest.chunks)) urls.push(...manifest.chunks.filter((url: unknown): url is string => typeof url === 'string'))
      urls[0] = manifestUrl
    }
    for (const url of urls) await cloudinary.uploader.destroy(publicIdFromUrl(url), { resource_type: 'raw' })
  } catch (_) {}
}

export const isChunkedCloudinaryAsset = (assetUrl: string) => assetUrl.startsWith(CHUNK_MANIFEST_PREFIX)
