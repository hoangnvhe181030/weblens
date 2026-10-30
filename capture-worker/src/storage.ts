import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { stat, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Transform, addAbortSignal } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import {
  CopyObjectCommand,
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import type { Config } from './config.js'
import type { StoredObject } from './types.js'

export class ObjectStorage {
  private readonly client: S3Client
  private readonly shutdown = new AbortController()

  constructor(private readonly config: Config) {
    this.client = new S3Client({
      endpoint: config.s3Endpoint,
      region: config.s3Region,
      forcePathStyle: true,
      maxAttempts: 2,
      credentials: { accessKeyId: config.s3AccessKey, secretAccessKey: config.s3SecretKey },
    })
  }

  private deadline(signal?: AbortSignal): AbortSignal {
    const timeout = AbortSignal.timeout(this.config.storageRequestTimeoutMillis ?? 120_000)
    return AbortSignal.any([timeout, this.shutdown.signal, ...(signal ? [signal] : [])])
  }

  close(): void {
    this.shutdown.abort(new Error('WORKER_SHUTDOWN'))
    this.client.destroy()
  }

  async ensureBucket(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.config.s3Bucket }), { abortSignal: this.deadline() })
    } catch (error) {
      if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode !== 404) throw error
      await this.client.send(new CreateBucketCommand({ Bucket: this.config.s3Bucket }), { abortSignal: this.deadline() })
    }
  }

  async put(key: string, body: Buffer, contentType: string, signal?: AbortSignal): Promise<StoredObject> {
    const sha256 = createHash('sha256').update(body).digest()
    await this.client.send(new PutObjectCommand({
      Bucket: this.config.s3Bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
      Metadata: { sha256: sha256.toString('hex') },
    }), { abortSignal: this.deadline(signal) })
    return { bucket: this.config.s3Bucket, key, bytes: body.length, sha256, contentType }
  }

  async putFile(key: string, path: string, contentType: string, maxBytes: number, signal?: AbortSignal): Promise<StoredObject> {
    const deadline = this.deadline(signal)
    const size = (await stat(path)).size
    if (size <= 0 || size > maxBytes) throw new Error('ARTIFACT_SIZE_OUT_OF_BOUNDS')
    const hash = createHash('sha256')
    for await (const chunk of addAbortSignal(deadline, createReadStream(path))) hash.update(chunk as Buffer)
    const sha256 = hash.digest()
    const body = addAbortSignal(deadline, createReadStream(path))
    try {
      await this.client.send(new PutObjectCommand({
      Bucket: this.config.s3Bucket,
      Key: key,
      Body: body,
      ContentLength: size,
      ContentType: contentType,
      Metadata: { sha256: sha256.toString('hex') },
      }), { abortSignal: deadline })
    } finally {
      body.destroy()
    }
    return { bucket: this.config.s3Bucket, key, bytes: size, sha256, contentType }
  }

  async delete(object: StoredObject, signal?: AbortSignal): Promise<void> {
    if (object.bucket !== this.config.s3Bucket) throw new Error('INVALID_STORAGE_BUCKET')
    await this.client.send(new DeleteObjectCommand({ Bucket: object.bucket, Key: object.key }), { abortSignal: this.deadline(signal) })
  }

  async copy(object: StoredObject, key: string, signal?: AbortSignal): Promise<StoredObject> {
    if (object.bucket !== this.config.s3Bucket) throw new Error('INVALID_STORAGE_BUCKET')
    const source = `${object.bucket}/${object.key.split('/').map(encodeURIComponent).join('/')}`
    await this.client.send(new CopyObjectCommand({
      Bucket: object.bucket,
      Key: key,
      CopySource: source,
      MetadataDirective: 'COPY',
    }), { abortSignal: this.deadline(signal) })
    return { ...object, key }
  }

  async verify(object: StoredObject, signal?: AbortSignal): Promise<void> {
    if (object.bucket !== this.config.s3Bucket) throw new Error('INVALID_STORAGE_BUCKET')
    const head = await this.client.send(new HeadObjectCommand({ Bucket: object.bucket, Key: object.key }), { abortSignal: this.deadline(signal) })
    if (head.ContentLength !== object.bytes
        || head.Metadata?.['sha256'] !== object.sha256.toString('hex')) {
      throw new Error('ARTIFACT_OBJECT_INTEGRITY_FAILED')
    }
  }

  async downloadFile(bucket: string, key: string, maximumBytes: number): Promise<{
    path: string; bytes: number; sha256Hex: string; cleanup: () => Promise<void>
  }> {
    if (bucket !== this.config.s3Bucket) throw new Error('INVALID_STORAGE_BUCKET')
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0 || maximumBytes > 256 * 1024 * 1024) {
      throw new Error('ARTIFACT_SIZE_MISMATCH')
    }
    const directory = await mkdtemp(join(tmpdir(), 'weblens-download-'))
    const path = join(directory, 'artifact')
    const cleanup = () => rm(directory, { recursive: true, force: true })
    try {
      const deadline = this.deadline()
      const result = await this.client.send(new GetObjectCommand({ Bucket: bucket, Key: key }),
        { abortSignal: deadline })
      if (!result.Body) throw new Error('ARTIFACT_OBJECT_MISSING')
      const input = result.Body as Readable
      if (result.ContentLength !== undefined && result.ContentLength > maximumBytes) {
        input.destroy()
        throw new Error('ARTIFACT_SIZE_MISMATCH')
      }
      const hash = createHash('sha256')
      let bytes = 0
      await pipeline(input, new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.length
          if (bytes > maximumBytes) return callback(new Error('ARTIFACT_SIZE_MISMATCH'))
          hash.update(chunk)
          callback(null, chunk)
        },
      }), createWriteStream(path), { signal: deadline })
      return { path, bytes, sha256Hex: hash.digest('hex'), cleanup }
    } catch (error) {
      await cleanup()
      const awsError = error as { name?: string; $metadata?: { httpStatusCode?: number } }
      if (awsError.name === 'NoSuchKey' || awsError.$metadata?.httpStatusCode === 404) throw new Error('ARTIFACT_OBJECT_MISSING')
      throw error
    }
  }

  async get(bucket: string, key: string, maximumBytes = 64 * 1024 * 1024, signal?: AbortSignal): Promise<Buffer> {
    if (bucket !== this.config.s3Bucket) throw new Error('INVALID_STORAGE_BUCKET')
    try {
      const deadline = this.deadline(signal)
      const result = await this.client.send(new GetObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: deadline })
      if (!result.Body) throw new Error('ARTIFACT_OBJECT_MISSING')
      const input = addAbortSignal(deadline, result.Body as Readable)
      if (result.ContentLength !== undefined && result.ContentLength > maximumBytes) {
        input.destroy()
        throw new Error('ARTIFACT_SIZE_MISMATCH')
      }
      const chunks: Buffer[] = []
      let bytes = 0
      for await (const chunk of input) {
        bytes += (chunk as Buffer).length
        if (bytes > maximumBytes) throw new Error('ARTIFACT_SIZE_MISMATCH')
        chunks.push(chunk as Buffer)
      }
      return Buffer.concat(chunks, bytes)
    } catch (error) {
      const awsError = error as { name?: string; $metadata?: { httpStatusCode?: number } }
      if (awsError.name === 'NoSuchKey' || awsError.name === 'NotFound'
        || awsError.$metadata?.httpStatusCode === 404) {
        throw new Error('ARTIFACT_OBJECT_MISSING')
      }
      throw error
    }
  }
}
