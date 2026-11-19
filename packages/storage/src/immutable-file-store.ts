import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { FileOwnerSchema, ImmutableFileSchema, type FileOwner, type ImmutableFile } from '@workmate/contracts';

export class ImmutableFileError extends Error {
  constructor(public readonly code: 'INVALID_FILE' | 'UNSAFE_PATH' | 'CORRUPT_FILE', message: string) {
    super(message); this.name = 'ImmutableFileError';
  }
}
export function fileOwnerKey(owner: FileOwner): string {
  const value = FileOwnerSchema.parse(owner);
  return createHash('sha256').update(JSON.stringify([value.orgId, value.userId])).digest('hex');
}

/** API-owned root must be trusted. No client paths and no deletion/overwrite operation. */
export class ImmutableFileStore {
  private readonly root: string;
  constructor(root: string) {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(root).isSymbolicLink()) throw new ImmutableFileError('UNSAFE_PATH', 'File root cannot be a symbolic link');
    this.root = fs.realpathSync(root);
  }
  private directory(owner: FileOwner, create: boolean): string {
    const directory = path.join(this.root, fileOwnerKey(owner));
    if (create) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new ImmutableFileError('UNSAFE_PATH', 'Unsafe owner directory');
    return directory;
  }
  put(owner: FileOwner, bytes: Uint8Array): ImmutableFile {
    if (!bytes.length || bytes.length > 25 * 1024 * 1024) throw new ImmutableFileError('INVALID_FILE', 'Source must contain 1 byte to 25 MB');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const file = { blobId: sha256, sha256, sizeBytes: bytes.length };
    const directory = this.directory(owner, true);
    const target = path.join(directory, sha256);
    const temporary = path.join(directory, `.pending-${randomUUID()}`);
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try {
      try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      // Linking our own complete temporary file publishes atomically without replacing an existing blob.
      try { fs.linkSync(temporary, target); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      this.read(owner, file);
      if (process.platform !== 'win32') {
        const directoryFd = fs.openSync(directory, 'r');
        try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
      }
      return file;
    } finally { fs.unlinkSync(temporary); }
  }
  read(owner: FileOwner, reference: ImmutableFile): Buffer {
    const file = ImmutableFileSchema.parse(reference);
    if (file.blobId !== file.sha256) throw new ImmutableFileError('CORRUPT_FILE', 'Blob identity mismatch');
    const target = path.join(this.directory(owner, false), file.blobId);
    if (fs.lstatSync(target).isSymbolicLink()) throw new ImmutableFileError('UNSAFE_PATH', 'Blob cannot be a symbolic link');
    const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size !== file.sizeBytes) throw new ImmutableFileError('CORRUPT_FILE', 'Source size mismatch');
      const bytes = fs.readFileSync(fd);
      if (createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new ImmutableFileError('CORRUPT_FILE', 'Source hash mismatch');
      return bytes;
    } finally { fs.closeSync(fd); }
  }
}
