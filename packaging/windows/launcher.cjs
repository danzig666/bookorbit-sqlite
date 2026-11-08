"use strict";

// Entry point of the portable Windows build. It runs inside a Node single executable application,
// so only built-in modules are available here. The app itself, its Node runtime, PostgreSQL and
// the helper tools travel as one compressed asset that is unpacked next to the executable.

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const crypto = require("node:crypto");
const net = require("node:net");
const http = require("node:http");
const os = require("node:os");
const { spawn, spawnSync } = require("node:child_process");

const IS_WINDOWS = process.platform === "win32";
const DB_NAME = "bookorbit";
const DB_USER = "bookorbit";
const DEFAULT_APP_PORT = 6262;
const DEFAULT_DB_PORT = 54329;
const HEALTH_TIMEOUT_MS = 10 * 60_000;

const RECORD_DIR = 1;
const RECORD_FILE = 2;
const RECORD_LINK = 3;

function loadSea() {
  try {
    const sea = require("node:sea");
    return sea.isSea() ? sea : null;
  } catch {
    return null;
  }
}

const sea = loadSea();

function parseArgs(argv) {
  const args = { runtime: null, home: null, noBrowser: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--runtime") args.runtime = argv[++i];
    else if (arg === "--home") args.home = argv[++i];
    else if (arg === "--no-browser") args.noBrowser = true;
  }
  return args;
}

function log(message) {
  process.stdout.write(`[BookOrbit] ${message}\n`);
}

function exe(name) {
  return IS_WINDOWS ? `${name}.exe` : name;
}

function readManifest(args) {
  if (sea) return JSON.parse(sea.getAsset("manifest.json", "utf8"));
  if (!args.runtime) throw new Error("Pass --runtime <dir> when running the launcher outside the packaged executable.");
  const manifestPath = path.join(args.runtime, "manifest.json");
  return fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, "utf8")) : { version: "dev" };
}

function resolveHome(args) {
  if (args.home) return path.resolve(args.home);
  if (process.env.BOOKORBIT_HOME) return path.resolve(process.env.BOOKORBIT_HOME);
  const baseDir = sea ? path.dirname(process.execPath) : process.cwd();
  return path.join(baseDir, "BookOrbit-data");
}

// ---------------------------------------------------------------------------
// Runtime extraction
// ---------------------------------------------------------------------------

class RuntimeUnpacker {
  constructor(targetDir, onProgress) {
    this.targetDir = targetDir;
    this.onProgress = onProgress;
    this.buffer = Buffer.alloc(0);
    this.state = "header";
    this.current = null;
    this.fd = null;
    this.remaining = 0;
    this.files = 0;
  }

  push(chunk) {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.state === "header") {
        if (!this.readHeader()) return;
      } else if (this.state === "data") {
        if (!this.readData()) return;
      }
    }
  }

  readHeader() {
    if (this.buffer.length < 5) return false;
    const type = this.buffer.readUInt8(0);
    const nameLength = this.buffer.readUInt32BE(1);
    const fixed = 5 + nameLength;
    const headerLength = type === RECORD_DIR ? fixed : fixed + (type === RECORD_FILE ? 8 : 4);
    if (this.buffer.length < headerLength) return false;

    const name = this.buffer.toString("utf8", 5, fixed);
    const target = this.safeJoin(name);
    if (type === RECORD_DIR) {
      fs.mkdirSync(target, { recursive: true });
      this.buffer = this.buffer.subarray(headerLength);
      return true;
    }
    if (type === RECORD_LINK) {
      const linkLength = this.buffer.readUInt32BE(fixed);
      if (this.buffer.length < headerLength + linkLength) return false;
      const linkTarget = this.safeJoin(this.buffer.toString("utf8", headerLength, headerLength + linkLength));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.symlinkSync(linkTarget, target, IS_WINDOWS ? "junction" : "dir");
      this.buffer = this.buffer.subarray(headerLength + linkLength);
      return true;
    }
    if (type !== RECORD_FILE) throw new Error(`Corrupt runtime archive: unknown record type ${type}`);

    this.remaining = Number(this.buffer.readBigUInt64BE(fixed));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    this.fd = fs.openSync(target, "w");
    this.buffer = this.buffer.subarray(headerLength);
    this.state = "data";
    return true;
  }

  readData() {
    if (this.remaining > 0) {
      if (this.buffer.length === 0) return false;
      const take = Math.min(this.remaining, this.buffer.length);
      fs.writeSync(this.fd, this.buffer, 0, take);
      this.buffer = this.buffer.subarray(take);
      this.remaining -= take;
      if (this.remaining > 0) return false;
    }
    fs.closeSync(this.fd);
    this.fd = null;
    this.files += 1;
    this.state = "header";
    return true;
  }

  finish() {
    if (this.state !== "header" || this.buffer.length !== 0) throw new Error("Corrupt runtime archive: truncated data");
  }

  safeJoin(relativePath) {
    const resolved = path.resolve(this.targetDir, ...relativePath.split("/"));
    if (resolved !== this.targetDir && !resolved.startsWith(this.targetDir + path.sep)) {
      throw new Error(`Corrupt runtime archive: path escapes target (${relativePath})`);
    }
    return resolved;
  }
}

function unpackRuntime(archive, targetDir) {
  return new Promise((resolve, reject) => {
    const unpacker = new RuntimeUnpacker(targetDir);
    const gunzip = zlib.createGunzip();
    const total = archive.length;
    const chunkSize = 4 * 1024 * 1024;
    let offset = 0;
    let lastPercent = -1;

    gunzip.on("data", (chunk) => {
      try {
        unpacker.push(chunk);
      } catch (error) {
        gunzip.destroy(error);
      }
    });
    gunzip.on("error", reject);
    gunzip.on("end", () => {
      try {
        unpacker.finish();
        process.stdout.write("\n");
        resolve(unpacker.files);
      } catch (error) {
        reject(error);
      }
    });

    const pump = () => {
      while (offset < total) {
        const end = Math.min(total, offset + chunkSize);
        const ok = gunzip.write(archive.subarray(offset, end));
        offset = end;
        const percent = Math.floor((offset / total) * 100);
        if (percent !== lastPercent) {
          lastPercent = percent;
          process.stdout.write(`\r[BookOrbit] Unpacking runtime... ${percent}%`);
        }
        if (!ok) {
          gunzip.once("drain", pump);
          return;
        }
      }
      gunzip.end();
    };
    pump();
  });
}

async function ensureRuntime(args, home, manifest) {
  if (!sea) return path.resolve(args.runtime);

  const runtimeRoot = path.join(home, "runtime");
  const runtimeDir = path.join(runtimeRoot, manifest.version);
  const marker = path.join(runtimeDir, ".complete");
  if (fs.existsSync(marker)) return runtimeDir;

  log(`First start of version ${manifest.version}: unpacking the runtime. This takes a minute.`);
  // Unpack in place: junctions need absolute targets, so the folder cannot be renamed afterwards.
  // The marker file is written last, so an interrupted unpack is redone on the next start.
  fs.rmSync(runtimeDir, { recursive: true, force: true });
  fs.mkdirSync(runtimeDir, { recursive: true });

  const archive = Buffer.from(sea.getRawAsset("runtime.bin"));
  const files = await unpackRuntime(archive, runtimeDir);
  fs.writeFileSync(marker, `${manifest.version}\n`);
  log(`Unpacked ${files} files.`);
  return runtimeDir;
}

function removeOldRuntimes(home, keepVersion) {
  const runtimeRoot = path.join(home, "runtime");
  if (!fs.existsSync(runtimeRoot)) return;
  for (const entry of fs.readdirSync(runtimeRoot)) {
    if (entry === keepVersion) continue;
    try {
      fs.rmSync(path.join(runtimeRoot, entry), { recursive: true, force: true });
    } catch {
      // A file in use by a process that is still shutting down; it is retried on the next start.
    }
  }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function randomHex(bytes) {
  return crypto.randomBytes(bytes).toString("hex");
}

function parseEnvFile(content) {
  const values = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function defaultSettingsFile() {
  return [
    "# BookOrbit portable settings. Edit this file and restart BookOrbit to apply changes.",
    "# Any BookOrbit server environment variable can be added here (see server/.env.example).",
    "",
    "# Web port. Open http://localhost:<PORT> in a browser.",
    `PORT=${DEFAULT_APP_PORT}`,
    "# 0.0.0.0 lets other devices on your network (for example a Kobo) reach BookOrbit.",
    "# Use 127.0.0.1 to allow this computer only.",
    "HOST=0.0.0.0",
    `APP_URL=http://localhost:${DEFAULT_APP_PORT}`,
    "",
    "# Folders the library picker may open. Leave empty to allow every drive, mapped network drive",
    "# and network share (\\\\server\\share). To restrict it, list folders separated by ;",
    "# for example D:\\Books;G:\\BT\\eBook",
    "LIBRARY_BROWSE_ROOT=",
    "",
    "# Set to false to stop BookOrbit from opening a browser window on start.",
    "OPEN_BROWSER=true",
    "",
    "# Node.js heap limit for the server in MB.",
    "NODE_MAX_OLD_SPACE_SIZE=2048",
    "",
    "# Secrets generated on first start. Keep this file private.",
    "# Enter SETUP_BOOTSTRAP_TOKEN on the first-run setup page to create the admin account.",
    `SETUP_BOOTSTRAP_TOKEN=${randomHex(12)}`,
    `JWT_SECRET=${randomHex(32)}`,
    `EMAIL_ENCRYPTION_KEY=${randomHex(32)}`,
    `MIGRATION_ENCRYPTION_KEY=${randomHex(32)}`,
    `BOOK_REQUEST_ENCRYPTION_KEY=${randomHex(32)}`,
    "",
    "# Password of the bundled database. Do not change it after the first start.",
    `BOOKORBIT_DB_PASSWORD=${randomHex(24)}`,
    "",
  ].join(os.EOL);
}

function loadSettings(home) {
  const settingsPath = path.join(home, "bookorbit.env");
  if (!fs.existsSync(settingsPath)) {
    fs.writeFileSync(settingsPath, defaultSettingsFile());
    log(`Created settings file: ${settingsPath}`);
  }
  return { settingsPath, values: parseEnvFile(fs.readFileSync(settingsPath, "utf8")) };
}

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------

function findPathKey(env) {
  return Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
}

function withPath(env, directories) {
  const result = { ...env };
  const key = findPathKey(result);
  const existing = result[key] ? [result[key]] : [];
  result[key] = [...directories, ...existing].join(path.delimiter);
  return result;
}

function runSync(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, { encoding: "utf8", windowsHide: true, ...options });
  if (result.error) throw result.error;
  return result;
}

function runChecked(label, command, commandArgs, options = {}) {
  const result = runSync(command, commandArgs, options);
  if (result.status !== 0) {
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    throw new Error(`${label} failed with exit code ${result.status}${output ? `:\n${output}` : ""}`);
  }
  return result;
}

function isPortFree(port, host) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(port, host);
  });
}

async function findFreePort(start, host) {
  for (let port = start; port < start + 100; port += 1) {
    if (await isPortFree(port, host)) return port;
  }
  throw new Error(`No free port found between ${start} and ${start + 99}`);
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function acquireInstanceLock(home) {
  const lockPath = path.join(home, "bookorbit.pid");
  if (fs.existsSync(lockPath)) {
    const pid = Number.parseInt(fs.readFileSync(lockPath, "utf8"), 10);
    if (Number.isInteger(pid) && pid !== process.pid && isProcessAlive(pid)) {
      throw new Error(`BookOrbit is already running from this folder (process ${pid}). Close that window first.`);
    }
  }
  fs.writeFileSync(lockPath, String(process.pid));
  return () => {
    try {
      if (fs.readFileSync(lockPath, "utf8") === String(process.pid)) fs.rmSync(lockPath, { force: true });
    } catch {
      // Already gone.
    }
  };
}

function tailFile(filePath, lines) {
  try {
    return fs.readFileSync(filePath, "utf8").split(/\r?\n/).slice(-lines).join("\n");
  } catch {
    return "(no log available)";
  }
}

function rotateLog(filePath) {
  if (!fs.existsSync(filePath)) return;
  try {
    fs.renameSync(filePath, `${filePath}.1`);
  } catch {
    // Keep appending when the previous log is locked.
  }
}

// ---------------------------------------------------------------------------
// PostgreSQL
// ---------------------------------------------------------------------------

class Database {
  constructor(runtimeDir, home, password) {
    this.binDir = path.join(runtimeDir, "pgsql", "bin");
    this.dataDir = path.join(home, "postgres");
    this.logFile = path.join(home, "logs", "postgres.log");
    this.socketDir = IS_WINDOWS ? null : fs.mkdtempSync(path.join(os.tmpdir(), "bookorbit-pg-"));
    this.password = password;
    this.port = null;
    this.started = false;
    this.env = withPath({ ...process.env, PGPASSWORD: password }, [this.binDir]);
    delete this.env.PGDATA;
  }

  bin(name) {
    return path.join(this.binDir, exe(name));
  }

  isInitialized() {
    return fs.existsSync(path.join(this.dataDir, "PG_VERSION"));
  }

  initialize() {
    log("Creating the database. This only happens on the first start.");
    const passwordFile = path.join(os.tmpdir(), `bookorbit-pw-${process.pid}-${randomHex(4)}`);
    fs.writeFileSync(passwordFile, this.password, { mode: 0o600 });
    const baseArgs = ["-D", this.dataDir, "-U", DB_USER, `--pwfile=${passwordFile}`, "--auth=scram-sha-256", "--encoding=UTF8"];
    // A linguistic locale matches the Docker image (en_US.utf8). The builtin provider is the fallback
    // for systems where that locale is missing; it still gives Unicode-aware case mapping.
    const localeAttempts = IS_WINDOWS
      ? [["--locale=en-US"], ["--locale=C", "--locale-provider=builtin", "--builtin-locale=C.UTF-8"]]
      : [["--locale=C.UTF-8"], ["--locale=C", "--locale-provider=builtin", "--builtin-locale=C.UTF-8"]];
    try {
      let lastError = null;
      for (const localeArgs of localeAttempts) {
        try {
          runChecked("initdb", this.bin("initdb"), [...baseArgs, ...localeArgs], { env: this.env });
          return;
        } catch (error) {
          lastError = error;
          fs.rmSync(this.dataDir, { recursive: true, force: true });
        }
      }
      throw lastError;
    } finally {
      fs.rmSync(passwordFile, { force: true });
    }
  }

  stopStale() {
    if (!fs.existsSync(path.join(this.dataDir, "postmaster.pid"))) return;
    const status = runSync(this.bin("pg_ctl"), ["status", "-D", this.dataDir], { env: this.env });
    if (status.status === 0) {
      log("Stopping a database server left running by a previous session.");
      runSync(this.bin("pg_ctl"), ["stop", "-D", this.dataDir, "-m", "fast", "-w", "-t", "60"], { env: this.env, stdio: "ignore" });
    }
  }

  async start() {
    this.stopStale();
    this.port = await findFreePort(DEFAULT_DB_PORT, "127.0.0.1");
    rotateLog(this.logFile);
    const serverOptions = [`-p ${this.port}`, "-c listen_addresses=127.0.0.1"];
    if (this.socketDir) serverOptions.push(`-k ${this.socketDir}`);
    log(`Starting the database on port ${this.port}.`);
    // The postmaster inherits pg_ctl's standard handles, so piping them would block until the
    // database stops. Its output goes to the log file instead.
    const result = runSync(this.bin("pg_ctl"), ["start", "-D", this.dataDir, "-l", this.logFile, "-w", "-t", "120", "-o", serverOptions.join(" ")], {
      env: this.env,
      stdio: "ignore",
    });
    if (result.status !== 0) {
      throw new Error(`Starting PostgreSQL failed with exit code ${result.status}. Last log lines:\n${tailFile(this.logFile, 30)}`);
    }
    this.started = true;
  }

  ensureDatabase() {
    const query = runChecked(
      "Checking the database",
      this.bin("psql"),
      ["-h", "127.0.0.1", "-p", String(this.port), "-U", DB_USER, "-d", "postgres", "-tAc", `SELECT 1 FROM pg_database WHERE datname = '${DB_NAME}'`],
      { env: this.env },
    );
    if (query.stdout.trim() === "1") return;
    runChecked("Creating the database", this.bin("createdb"), ["-h", "127.0.0.1", "-p", String(this.port), "-U", DB_USER, DB_NAME], {
      env: this.env,
    });
  }

  connectionString() {
    return `postgres://${DB_USER}:${encodeURIComponent(this.password)}@127.0.0.1:${this.port}/${DB_NAME}`;
  }

  stop() {
    if (!this.started) return;
    this.started = false;
    log("Stopping the database.");
    runSync(this.bin("pg_ctl"), ["stop", "-D", this.dataDir, "-m", "fast", "-w", "-t", "60"], { env: this.env, stdio: "ignore" });
    if (this.socketDir) fs.rmSync(this.socketDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// App server
// ---------------------------------------------------------------------------

function buildServerEnv(runtimeDir, home, settings, database, appPort) {
  const appDir = path.join(runtimeDir, "app");
  const toolDirs = ["ffmpeg", "poppler"].map((tool) => path.join(runtimeDir, "tools", tool, "bin")).filter((dir) => fs.existsSync(dir));
  const env = withPath({ ...process.env }, [...toolDirs, path.join(runtimeDir, "node")]);

  Object.assign(env, settings, {
    NODE_ENV: "production",
    PORT: String(appPort),
    DATABASE_URL: database.connectionString(),
    APP_DATA_PATH: settings.APP_DATA_PATH?.trim() || path.join(home, "data"),
    LIBRARY_BROWSE_ROOT: settings.LIBRARY_BROWSE_ROOT?.trim() ?? "",
    KOREADER_PLUGIN_PATH: settings.KOREADER_PLUGIN_PATH?.trim() || path.join(appDir, "koreader-plugin", "bookorbit.koplugin"),
    APP_VERSION: settings.APP_VERSION?.trim() || process.env.APP_VERSION || "",
  });
  const ffmpegDir = path.join(runtimeDir, "tools", "ffmpeg", "bin");
  if (!settings.FFMPEG_PATH && fs.existsSync(path.join(ffmpegDir, exe("ffmpeg")))) env.FFMPEG_PATH = path.join(ffmpegDir, exe("ffmpeg"));
  if (!settings.FFPROBE_PATH && fs.existsSync(path.join(ffmpegDir, exe("ffprobe")))) env.FFPROBE_PATH = path.join(ffmpegDir, exe("ffprobe"));
  delete env.BOOKORBIT_DB_PASSWORD;
  delete env.OPEN_BROWSER;
  delete env.NODE_MAX_OLD_SPACE_SIZE;
  fs.mkdirSync(env.APP_DATA_PATH, { recursive: true });
  return env;
}

function nodeBinary(runtimeDir) {
  const bundled = path.join(runtimeDir, "node", exe("node"));
  return fs.existsSync(bundled) ? bundled : process.execPath;
}

function runMigrations(runtimeDir, env) {
  log("Applying database migrations.");
  const appDir = path.join(runtimeDir, "app");
  runChecked("Database migration", nodeBinary(runtimeDir), [path.join(appDir, "dist", "scripts", "migrate.js")], {
    cwd: appDir,
    env,
    stdio: "inherit",
  });
}

function startServer(runtimeDir, home, env, heapMb) {
  const appDir = path.join(runtimeDir, "app");
  const logFile = path.join(home, "logs", "server.log");
  rotateLog(logFile);
  const logStream = fs.createWriteStream(logFile, { flags: "a" });
  const child = spawn(nodeBinary(runtimeDir), [`--max-old-space-size=${heapMb}`, path.join(appDir, "dist", "main.js")], {
    cwd: appDir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => {
      process.stdout.write(chunk);
      logStream.write(chunk);
    });
  }
  child.on("exit", () => logStream.end());
  return child;
}

function getJson(port, requestPath) {
  return new Promise((resolve) => {
    const request = http.get({ host: "127.0.0.1", port, path: requestPath, timeout: 5000 }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => {
        try {
          resolve(response.statusCode === 200 ? JSON.parse(body) : null);
        } catch {
          resolve(null);
        }
      });
    });
    request.on("timeout", () => request.destroy());
    request.on("error", () => resolve(null));
  });
}

/** The page to open: the first-run setup form with its token filled in, or the app itself. */
async function startPageUrl(port, baseUrl, setupToken) {
  const status = await getJson(port, "/api/v1/auth/setup-status");
  if (!status?.needsSetup || !setupToken) return baseUrl;
  return `${baseUrl}/setup#setup-token=${encodeURIComponent(setupToken)}`;
}

function checkHealth(port) {
  return new Promise((resolve) => {
    const request = http.get({ host: "127.0.0.1", port, path: "/api/v1/health", timeout: 5000 }, (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.on("timeout", () => request.destroy());
    request.on("error", () => resolve(false));
  });
}

async function waitForHealth(port, child) {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return false;
    if (await checkHealth(port)) return true;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}

function openBrowser(url) {
  try {
    // url.dll keeps the #fragment that carries the setup token; explorer.exe can drop it.
    if (IS_WINDOWS) spawn("rundll32.exe", ["url.dll,FileProtocolHandler", url], { detached: true, stdio: "ignore" }).unref();
    else
      spawn("xdg-open", [url], { detached: true, stdio: "ignore" })
        .on("error", () => {})
        .unref();
  } catch {
    // Opening a browser is a convenience only.
  }
}

function parseHeapSize(value) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 2048;
}

function isTruthy(value, fallback) {
  if (value === undefined || value.trim() === "") return fallback;
  return !["false", "0", "no", "off"].includes(value.trim().toLowerCase());
}

async function waitForKeypress() {
  if (!process.stdin.isTTY) return;
  process.stdout.write("\nPress Enter to close this window.\n");
  await new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.once("data", resolve);
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifest = readManifest(args);
  const home = resolveHome(args);
  fs.mkdirSync(path.join(home, "logs"), { recursive: true });

  log(`BookOrbit ${manifest.version} (portable)`);
  log(`Data folder: ${home}`);

  const releaseLock = acquireInstanceLock(home);
  const runtimeDir = await ensureRuntime(args, home, manifest);
  const { settingsPath, values: settings } = loadSettings(home);
  if (!settings.BOOKORBIT_DB_PASSWORD) throw new Error(`BOOKORBIT_DB_PASSWORD is missing from ${settingsPath}`);

  const appPort = Number.parseInt(settings.PORT ?? "", 10) || DEFAULT_APP_PORT;
  const appHost = settings.HOST?.trim() || "0.0.0.0";
  if (!(await isPortFree(appPort, appHost))) {
    throw new Error(`Port ${appPort} is already in use. Change PORT in ${settingsPath} and start BookOrbit again.`);
  }

  const database = new Database(runtimeDir, home, settings.BOOKORBIT_DB_PASSWORD);
  let server = null;
  let shuttingDown = false;

  const shutdown = (exitCode) => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (server && server.exitCode === null) {
      log("Stopping BookOrbit.");
      server.kill();
    }
    try {
      database.stop();
    } finally {
      releaseLock();
      process.exit(exitCode);
    }
  };

  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) {
    process.on(signal, () => shutdown(0));
  }

  try {
    if (!database.isInitialized()) database.initialize();
    await database.start();
    database.ensureDatabase();

    const env = buildServerEnv(runtimeDir, home, { ...settings, PORT: String(appPort), HOST: appHost }, database, appPort);
    runMigrations(runtimeDir, env);

    log("Starting BookOrbit.");
    server = startServer(runtimeDir, home, env, parseHeapSize(settings.NODE_MAX_OLD_SPACE_SIZE));
    server.on("exit", (code) => {
      if (shuttingDown) return;
      log(`BookOrbit stopped unexpectedly (exit code ${code}). See ${path.join(home, "logs", "server.log")}.`);
      shuttingDown = true;
      database.stop();
      releaseLock();
      void waitForKeypress().then(() => process.exit(code || 1));
    });

    if (!(await waitForHealth(appPort, server))) {
      if (server.exitCode === null) throw new Error("BookOrbit did not become ready in time.");
      return;
    }

    if (sea) removeOldRuntimes(home, manifest.version);
    const url = `http://localhost:${appPort}`;
    const startUrl = await startPageUrl(appPort, url, settings.SETUP_BOOTSTRAP_TOKEN);
    log(`BookOrbit is running at ${url}`);
    if (startUrl !== url) log(`First start: create your admin account at ${startUrl}`);
    log(`Settings: ${settingsPath}`);
    log("Close this window or press Ctrl+C to stop BookOrbit.");
    if (!args.noBrowser && isTruthy(process.env.BOOKORBIT_OPEN_BROWSER ?? settings.OPEN_BROWSER, true)) openBrowser(startUrl);
  } catch (error) {
    if (server && server.exitCode === null) server.kill();
    database.stop();
    releaseLock();
    throw error;
  }
}

main().catch(async (error) => {
  process.stderr.write(`\n[BookOrbit] Startup failed: ${error instanceof Error ? error.message : String(error)}\n`);
  await waitForKeypress();
  process.exit(1);
});
