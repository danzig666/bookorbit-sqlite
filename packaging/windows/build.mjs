// Packs a prepared runtime folder into the portable executable.
//
// Usage: node packaging/windows/build.mjs --runtime <dir> --version <x.y.z> --out <BookOrbit.exe>
//
// The runtime folder holds node/, app/, pgsql/ and tools/. It is stored as one gzip stream of
// simple records that launcher.cjs unpacks on the first start.

import { spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const RECORD_DIR = 1;
const RECORD_FILE = 2;
const RECORD_LINK = 3;
const SEA_FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

const here = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, "");
    if (!key || argv[i + 1] === undefined) throw new Error(`Missing value for ${argv[i]}`);
    args[key] = argv[i + 1];
  }
  for (const required of ["runtime", "version", "out"]) {
    if (!args[required]) throw new Error(`--${required} is required`);
  }
  return args;
}

function nameHeader(type, name, extra) {
  const nameBytes = Buffer.from(name, "utf8");
  const header = Buffer.alloc(5 + nameBytes.length);
  header.writeUInt8(type, 0);
  header.writeUInt32BE(nameBytes.length, 1);
  nameBytes.copy(header, 5);
  return extra ? Buffer.concat([header, extra]) : header;
}

function isInside(root, candidate) {
  return candidate === root || candidate.startsWith(root + path.sep);
}

async function packRuntime(runtimeDir, outFile) {
  const root = fs.realpathSync(runtimeDir);
  const gzip = zlib.createGzip({ level: 9 });
  const output = fs.createWriteStream(outFile);
  gzip.pipe(output);
  const stats = { files: 0, dirs: 0, links: 0, bytes: 0 };

  const write = async (buffer) => {
    if (!gzip.write(buffer)) await once(gzip, "drain");
  };

  const walk = async (absolute, relative) => {
    const entries = fs.readdirSync(absolute, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const entryPath = path.join(absolute, entry.name);
      const entryRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const lstat = fs.lstatSync(entryPath);

      if (lstat.isSymbolicLink()) {
        let target;
        try {
          target = fs.realpathSync(entryPath);
        } catch {
          console.warn(`Skipping broken link ${entryRelative}`);
          continue;
        }
        const targetStat = fs.statSync(target);
        if (targetStat.isDirectory() && isInside(root, target)) {
          const targetRelative = path.relative(root, target).split(path.sep).join("/");
          const targetBytes = Buffer.from(targetRelative, "utf8");
          const lengthBytes = Buffer.alloc(4);
          lengthBytes.writeUInt32BE(targetBytes.length);
          await write(nameHeader(RECORD_LINK, entryRelative, Buffer.concat([lengthBytes, targetBytes])));
          stats.links += 1;
          continue;
        }
        if (!isInside(root, target)) {
          // pnpm leaves links to unrelated workspace packages (server, client, workers) in the deploy.
          console.warn(`Skipping link outside the runtime: ${entryRelative} -> ${target}`);
          continue;
        }
        await writeFile(target, entryRelative);
        continue;
      }

      if (lstat.isDirectory()) {
        await write(nameHeader(RECORD_DIR, entryRelative));
        stats.dirs += 1;
        await walk(entryPath, entryRelative);
      } else if (lstat.isFile()) {
        await writeFile(entryPath, entryRelative);
      }
    }
  };

  const writeFile = async (filePath, relative) => {
    const content = fs.readFileSync(filePath);
    const sizeBytes = Buffer.alloc(8);
    sizeBytes.writeBigUInt64BE(BigInt(content.length));
    await write(nameHeader(RECORD_FILE, relative, sizeBytes));
    await write(content);
    stats.files += 1;
    stats.bytes += content.length;
  };

  await walk(root, "");
  gzip.end();
  await once(output, "close");
  return stats;
}

function run(command, args, options = {}) {
  console.log(`> ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { stdio: "inherit", shell: process.platform === "win32" && command === "npx", ...options });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function findSigntool() {
  const kitsBin = path.join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Windows Kits", "10", "bin");
  if (!fs.existsSync(kitsBin)) return null;
  const versions = fs
    .readdirSync(kitsBin)
    .filter((entry) => /^\d+\./.test(entry))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  for (const version of versions) {
    const candidate = path.join(kitsBin, version, "x64", "signtool.exe");
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

// node.exe is signed and the signature no longer matches once the blob is injected. Removing it is
// optional: the executable still runs with an invalid signature.
function removeSignature(file) {
  if (process.platform !== "win32") return;
  const signtool = findSigntool();
  if (!signtool) {
    console.warn("signtool not found; keeping the original signature");
    return;
  }
  if (run(signtool, ["remove", "/s", file]) !== 0) console.warn("signtool could not remove the signature");
}

function buildExecutable(workDir, assets, outFile) {
  const launcher = path.join(here, "launcher.cjs");
  const blob = path.join(workDir, "sea-prep.blob");
  const config = {
    main: launcher,
    output: blob,
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,
    assets,
  };
  const configPath = path.join(workDir, "sea-config.json");
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

  if (run(process.execPath, ["--experimental-sea-config", configPath]) === 0) {
    fs.copyFileSync(process.execPath, outFile);
    removeSignature(outFile);
    const status = run("npx", ["--yes", "postject@1.0.0-alpha.6", outFile, "NODE_SEA_BLOB", blob, "--sentinel-fuse", SEA_FUSE]);
    if (status !== 0) throw new Error("postject failed");
    return;
  }

  // Newer Node releases build the executable in one step.
  const buildConfigPath = path.join(workDir, "sea-build-config.json");
  fs.writeFileSync(buildConfigPath, JSON.stringify({ ...config, output: outFile, executable: process.execPath }, null, 2));
  if (run(process.execPath, ["--build-sea", buildConfigPath]) !== 0) throw new Error("Building the single executable failed");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runtimeDir = path.resolve(args.runtime);
  const outFile = path.resolve(args.out);
  const workDir = path.join(path.dirname(outFile), "sea-work");
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true });

  const manifestPath = path.join(workDir, "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify({ version: args.version, builtAt: new Date().toISOString() }));

  const archivePath = path.join(workDir, "runtime.bin");
  console.log(`Packing ${runtimeDir}`);
  const stats = await packRuntime(runtimeDir, archivePath);
  const archiveSize = fs.statSync(archivePath).size;
  console.log(
    `Packed ${stats.files} files, ${stats.dirs} folders, ${stats.links} links: ${(stats.bytes / 1e6).toFixed(1)} MB -> ${(archiveSize / 1e6).toFixed(1)} MB`,
  );

  buildExecutable(workDir, { "runtime.bin": archivePath, "manifest.json": manifestPath }, outFile);
  console.log(`Built ${outFile} (${(fs.statSync(outFile).size / 1e6).toFixed(1)} MB)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
