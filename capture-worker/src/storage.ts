import { createHash } from 'node:crypto'
import { CreateBucketCommand, GetObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import type { Config } from './config.js'
import type { StoredObject } from './types.js'

export class ObjectStorage {
  private readonly client: S3Client

  constructor(private readonly config: Config) {
    this.client = new S3Client({
      endpoint: config.s3Endpoint,
      region: config.s3Region,
      forcePathStyle: true,
      credentials: { accessKeyId: config.s3AccessKey, secretAccessKey: config.s3SecretKey },
    })
  }

  async ensureBucket(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.config.s3Bucket }))
    } catch {
      await this.client.send(new CreateBucketCommand({ Bucket: this.config.s3Bucket }))
    }
  }

  async put(key: string, body: Buffer, contentType: string): Promise<StoredObject> {
    const sha256 = createHash('sha256').update(body).digest()
    await this.client.send(new PutObjectCommand({
      Bucket: this.config.s3Bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
      Metadata: { sha256: sha256.toString('hex') },
    }))
    return { bucket: this.config.s3Bucket, key, bytes: body.length, sha256, contentType }
  }

  async get(bucket: string, key: string): Promise<Buffer> {
    if (bucket !== this.config.s3Bucket) throw new Error('INVALID_STORAGE_BUCKET')
    try {
      const result = await this.client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
      if (!result.Body) throw new Error('ARTIFACT_OBJECT_MISSING')
      return Buffer.from(await result.Body.transformToByteArray())
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
