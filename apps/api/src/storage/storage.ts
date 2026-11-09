import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

/** Armazenamento privado de arquivos. Nunca expõe URL pública. */
export interface ObjectStorage {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  remove(key: string): Promise<void>;
}
export const OBJECT_STORAGE = Symbol('OBJECT_STORAGE');

const SAFE_KEY = /^[a-z0-9][a-z0-9/._-]*$/i;
function assertKey(key: string) {
  if (!SAFE_KEY.test(key) || key.includes('..')) throw new Error('chave de armazenamento inválida');
}

/** Disco local: desenvolvimento e testes. */
export class LocalStorage implements ObjectStorage {
  private readonly root: string;
  constructor(root: string) {
    this.root = resolve(root);
  }
  private path(key: string) {
    assertKey(key);
    const p = resolve(join(this.root, key));
    if (!p.startsWith(this.root + sep)) throw new Error('chave fora do diretório');
    return p;
  }
  async put(key: string, body: Buffer) {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, body, { flag: 'wx' }); // nunca sobrescreve
  }
  get(key: string) {
    return readFile(this.path(key));
  }
  async remove(key: string) {
    await rm(this.path(key), { force: true });
  }
}

/** S3 ou compatível (MinIO). Bucket privado; criptografia no servidor. */
export class S3Storage implements ObjectStorage {
  private readonly s3: S3Client;
  constructor(private readonly bucket: string, opts: { endpoint?: string; region: string; forcePathStyle?: boolean }) {
    this.s3 = new S3Client({ region: opts.region, endpoint: opts.endpoint, forcePathStyle: opts.forcePathStyle });
  }
  async put(key: string, body: Buffer, contentType: string) {
    assertKey(key);
    await this.s3.send(new PutObjectCommand({
      Bucket: this.bucket, Key: key, Body: body, ContentType: contentType,
      ServerSideEncryption: 'AES256', IfNoneMatch: '*',
    }));
  }
  async get(key: string) {
    assertKey(key);
    const r = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return Buffer.from(await r.Body!.transformToByteArray());
  }
  async remove(key: string) {
    assertKey(key);
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}
