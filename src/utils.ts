import type { FileSystem } from '@effect/platform';
import { NodeFileSystem } from '@effect/platform-node';
import archiver from 'archiver';
import { bestzip } from 'bestzip';
import { type Cause, Effect, Option } from 'effect';
import execa from 'execa';
import fs from 'fs-extra';
import path from 'path';
import pMap from 'p-map';
import type { ESMPluginsModule, IFile, IFiles } from './types';
import FS, { FSyncLayer, makePath, makeTempPathScoped, safeFileExists } from './utils/effect-fs';

export class SpawnError extends Error {
  constructor(message: string, public stdout: string, public stderr: string) {
    super(message);
  }

  toString() {
    return `${this.message}\n${this.stderr}`;
  }
}

/**
 * Executes a child process without limitations on stdout and stderr.
 * On error (exit code is not 0), it rejects with a SpawnProcessError that contains the stdout and stderr streams,
 * on success it returns the streams in an object.
 * @param {string} command - Command
 * @param {string[]} [args] - Arguments
 * @param {Object} [options] - Options for child_process.spawn
 */
export function spawnProcess(command: string, args: string[], options: execa.Options) {
  return execa(command, args, options);
}

const rootOf = (p: string) => path.parse(path.resolve(p)).root;
const isPathRoot = (p: string) => rootOf(p) === path.resolve(p);
const findUpEffect = (
  names: string[],
  directory = process.cwd()
): Effect.Effect<string, Cause.NoSuchElementException, FileSystem.FileSystem> => {
  const dir = path.resolve(directory);
  return Effect.all(names.map((name) => safeFileExists(path.join(dir, name)))).pipe(
    Effect.flatMap((exist) => {
      if (exist.some(Boolean)) return Option.some(dir);
      if (isPathRoot(dir)) return Option.none();
      return findUpEffect(names, path.dirname(dir));
    })
  );
};

/**
 * Find a file by walking up parent directories
 */
export const findUp = (name: string) =>
  findUpEffect([name]).pipe(
    Effect.orElseSucceed(() => undefined),
    Effect.provide(FSyncLayer),
    Effect.runSync
  );

/**
 * Forwards `rootDir` or finds project root folder.
 */
export const findProjectRoot = (rootDir?: string) =>
  Effect.fromNullable(rootDir).pipe(
    Effect.orElse(() => findUpEffect(['yarn.lock', 'pnpm-lock.yaml', 'package-lock.json'])),
    Effect.orElseSucceed(() => undefined),
    Effect.provide(FSyncLayer),
    Effect.runSync
  );

export const humanSize = (size: number) => {
  const exponent = Math.floor(Math.log(size) / Math.log(1024));
  const sanitized = (size / 1024 ** exponent).toFixed(2);

  return `${sanitized} ${['B', 'KB', 'MB', 'GB', 'TB'][exponent]}`;
};

export const zip = async (
  zipPath: string,
  filesPathList: IFiles,
  useNativeZip: boolean | undefined,
  log: { verbose: (...inputs: any[]) => void }
): Promise<void> => {
  // create a temporary directory to hold the final zip structure
  const tempDirName = `${path.basename(zipPath, path.extname(zipPath))}-${Date.now().toString()}`;

  const copyFileEffect = (temp: string) => (file: IFile) => FS.copy(file.rootPath, path.join(temp, file.localPath));
  const bestZipEffect = (temp: string) =>
    Effect.tryPromise(() => bestzip({ source: '*', destination: zipPath, cwd: temp }));
  const nodeZipEffect = Effect.tryPromise(() => nodeZip(zipPath, filesPathList, log));

  const archiveEffect = makeTempPathScoped(tempDirName).pipe(
    // copy all required files from origin path to (sometimes modified) target path
    Effect.tap((temp) => Effect.all(filesPathList.map(copyFileEffect(temp)), { discard: true })),
    // prepare zip folder
    Effect.tap(() => makePath(path.dirname(zipPath))),
    // zip the temporary directory
    Effect.andThen((temp) => (useNativeZip ? bestZipEffect(temp) : nodeZipEffect)),
    Effect.scoped
  );

  await archiveEffect.pipe(Effect.provide(NodeFileSystem.layer), Effect.runPromise);
};

async function nodeZip(
  zipPath: string,
  filesPathList: IFiles,
  log: { verbose: (...inputs: any[]) => void }
): Promise<void> {
  let start = Date.now();
  const zipArchive = archiver.create('zip');
  const output = fs.createWriteStream(zipPath);

  const fileModes = new Map<string, number | undefined>();

  log.verbose(`nodeZip1 [${Date.now() - start} ms]`);
  start = Date.now();

  await pMap(filesPathList, async (file) => {
    const stats = await fs.stat(file.rootPath);

    if (!stats.isDirectory()) {
      fileModes.set(file.rootPath, stats.mode);
    }
  });

  log.verbose(`nodeZip2 [${Date.now() - start} ms]`);

  // write zip
  output.on('open', async () => {
    let start2 = Date.now();

    zipArchive.pipe(output);

    filesPathList.forEach((file) => {
      const exists = fileModes.has(file.rootPath);
      if (!exists) return;

      zipArchive.append(fs.readFileSync(file.rootPath), {
        name: file.localPath,
        mode: fileModes.get(file.rootPath),
        date: new Date(0), // necessary to get the same hash when zipping the same content
      });
    });

    log.verbose(`nodeZip.write [${Date.now() - start2} ms]`);
    start2 = Date.now();

    await zipArchive.finalize();

    log.verbose(`nodeZip.finalize [${Date.now() - start2} ms]`);
  });

  return new Promise((resolve, reject) => {
    output.on('close', resolve);
    zipArchive.on('error', (err) => reject(err));
  });
}

export function trimExtension(entry: string) {
  return entry.slice(0, -path.extname(entry).length);
}

export const isEmpty = (obj: Record<string, unknown>) => {
  // eslint-disable-next-line no-unreachable-loop
  for (const _i in obj) return false;

  return true;
};

export const isESMModule = (obj: unknown): obj is ESMPluginsModule => {
  return typeof obj === 'object' && obj !== null && 'default' in obj;
};
