// Vendored from DeepSeek Harness `@deepseek-ai/dsh-browser-use`
// 0.2.1-alpha.4.browser-policy.1, headless-engine.
//
// 为什么内联：官方从 DSH 0.2.2-rc.5 起不再发布 `@deepseek-ai/dsh-browser-use`
// （应用内 355 个官方包里已无此包，也无 `dsh-client-runtime` / `dsh-client-ui-slots`）。
// 继续依赖一个停发的包只能靠私有 tarball 副本，版本会永久漂移。本文件只取该包里
// **零第三方依赖的纯函数模块**，逻辑逐字保留，不引入任何官方内部 API。
//
// 上游许可：MIT（repository: github.com/deepseek-ai/deepseek-harness,
// packages/browser-use/browser-use）。改动本文件时请同步保持与上游等价。
//
// 钉死的 Chromium headless shell 解析与校验（SHA-256 清单 + Mach-O 头 + 版本子进程）。
/** Resolve an operation-local, pinned Playwright shell without GUI fallback. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { accessSync, constants, existsSync, lstatSync, openSync, readFileSync, readSync, realpathSync, closeSync } from 'node:fs';
import { arch, homedir, platform, release } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
/** A real installation/system check failed; no alternative browser was acquired. */
export class HeadlessEngineError extends Error {
    /** Stable resolver failure, separate from execution policy and backend launch errors. */
    code = 'HEADLESS_BROWSER_UNAVAILABLE';
    constructor(message, cause) {
        super(message, { cause });
        this.name = 'HeadlessEngineError';
    }
}
/** Require a nonblank text field without silently normalizing paths or identities. */
function text(value, label) {
    if (typeof value !== 'string' || !value.trim())
        throw new Error(`${label} must be a nonempty string`);
    return value;
}
/**
 * Admit the trusted adapter inventory and snapshot it before inspecting resources.
 * The declared pin type is narrowed from unknown here so a JavaScript adapter
 * cannot smuggle an unverified layout past these literal/layout comparisons.
 */
function snapshotPin(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        throw new Error('A trusted adapter pin is required');
    const input = value;
    for (const key of ['packageName', 'packageVersion', 'browserName', 'revision', 'browserVersion', 'directory', 'executable'])
        text(input[key], `pin.${key}`);
    if (input.packageName !== 'playwright-core' || input.browserName !== 'chromium-headless-shell')
        throw new Error('Only a pinned playwright-core Chromium headless shell is supported');
    const minimumDarwinMajor = input.minimumDarwinMajor;
    if (input.platform !== 'darwin' || input.arch !== 'arm64' || typeof minimumDarwinMajor !== 'number' || !Number.isInteger(minimumDarwinMajor) || minimumDarwinMajor < 20)
        throw new Error('The pin must specify a verified macOS arm64 installation and supported Darwin minimum');
    if (input.directory !== 'chrome-headless-shell-mac-arm64' || input.executable !== 'chrome-headless-shell' || typeof input.revision !== 'string' || !/^\d+$/.test(input.revision))
        throw new Error('The pin must describe the native arm64 headless shell layout and numeric revision');
    const inventory = input.files;
    if (inventory === null || typeof inventory !== 'object' || Array.isArray(inventory))
        throw new Error('The pin requires a complete resource SHA-256 inventory');
    const files = {};
    for (const [name, digest] of Object.entries(inventory)) {
        if (!name || isAbsolute(name) || name.split(/[\\/]/).some(part => !part || part === '.' || part === '..') || typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest))
            throw new Error('Pin resource names must be contained relative paths with SHA-256 digests');
        files[name] = digest;
    }
    if (!files[text(input.executable, 'pin.executable')] || Object.keys(files).length < 2)
        throw new Error('The pin must cover both the browser binary and installation resources');
    const source = input.source === undefined ? undefined : text(input.source, 'pin.source');
    const digestProvenance = input.digestProvenance === undefined ? undefined : text(input.digestProvenance, 'pin.digestProvenance');
    return Object.freeze({
        packageName: 'playwright-core',
        packageVersion: text(input.packageVersion, 'pin.packageVersion'),
        browserName: 'chromium-headless-shell',
        revision: text(input.revision, 'pin.revision'),
        browserVersion: text(input.browserVersion, 'pin.browserVersion'),
        platform: 'darwin',
        arch: 'arm64',
        minimumDarwinMajor,
        directory: 'chrome-headless-shell-mac-arm64',
        executable: 'chrome-headless-shell',
        files: Object.freeze(files),
        ...source === undefined ? {} : { source },
        ...digestProvenance === undefined ? {} : { digestProvenance },
    });
}
/** Hash actual bytes in bounded memory; caller input cannot replace this verifier. */
function hashFile(file) {
    const descriptor = openSync(file, 'r');
    try {
        const hash = createHash('sha256');
        const buffer = Buffer.allocUnsafe(1024 * 1024);
        for (;;) {
            const count = readSync(descriptor, buffer, 0, buffer.length, null);
            if (!count)
                break;
            hash.update(buffer.subarray(0, count));
        }
        return hash.digest('hex');
    }
    finally {
        closeSync(descriptor);
    }
}
/** Reject missing, empty, directory, or symlink installation members. */
function regular(file, nonempty = true) {
    const stat = lstatSync(file);
    if (!stat.isFile() || (nonempty && !stat.size))
        throw new Error(`Incomplete installation: ${file} must be a ${nonempty ? 'nonempty ' : ''}regular file`);
}
/** Validate the actual native Mach-O header before invoking the version subprocess. */
function nativeBinary(file) {
    const descriptor = openSync(file, 'r');
    const header = Buffer.alloc(32);
    try {
        if (readSync(descriptor, header, 0, header.length, 0) !== header.length)
            throw new Error('Browser binary has an incomplete native header');
    }
    finally {
        closeSync(descriptor);
    }
    if (header.readUInt32LE(0) !== 0xfeedfacf || header.readUInt32LE(12) !== 2)
        throw new Error('Expected a native Mach-O executable binary, not a script or renamed browser');
    if (header.readUInt32LE(4) !== 0x0100000c)
        throw new Error('Browser binary architecture must be native arm64; x64/Rosetta fallback is not allowed');
}
/** Decode only package metadata; malformed JSON cannot silently select another version. */
function record(file) {
    const value = JSON.parse(readFileSync(file, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error(`Invalid package metadata: ${file}`);
    return value;
}
/**
 * Reject unsupported knobs instead of exposing verification substitutes to production callers.
 * The declared options type is narrowed from unknown so a JavaScript caller cannot
 * inject a verification seam that the typed surface would have refused.
 */
function validateOptions(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Headless engine resolution requires explicit options');
    const allowed = new Set(['pin', 'playwrightPackageRoot', 'overrideName', 'env', 'cwd', 'executablePath']);
    for (const key of Object.keys(value))
        if (!allowed.has(key))
            throw new Error(`Unsupported headless engine resolution field: ${key}`);
}
/**
 * Resolve and verify one exact pinned installation for the current operation.
 * The pin is trusted adapter configuration, not caller/tool JSON. System identity,
 * SHA-256 verification, and the version subprocess are real Node dependencies.
 * @param options - trusted pin/package root, operation environment/cwd, and optional explicit executable.
 * @returns immutable engine identity consumed by final browser execution validation.
 * @throws HeadlessEngineError for malformed inputs, unsupported systems, or any failed installation check.
 */
export function resolvePinnedHeadlessEngine(options) {
    let overrideName;
    try {
        validateOptions(options);
        const pin = snapshotPin(options.pin);
        overrideName = text(options.overrideName, 'overrideName');
        if (!/^[A-Z_][A-Z0-9_]*$/.test(overrideName))
            throw new Error('overrideName must be an environment variable name');
        const packageRoot = text(options.playwrightPackageRoot, 'playwrightPackageRoot');
        if (!isAbsolute(packageRoot))
            throw new Error('playwrightPackageRoot must be an absolute adapter-owned package path');
        const cwd = options.cwd === undefined ? process.cwd() : text(options.cwd, 'cwd');
        if (!isAbsolute(cwd))
            throw new Error('cwd must be the absolute execution working directory');
        const configuredEnv = options.env;
        if (configuredEnv !== undefined && (configuredEnv === null || typeof configuredEnv !== 'object' || Array.isArray(configuredEnv)))
            throw new Error('env must be the operation environment');
        const env = (configuredEnv ?? process.env);
        const fromEnv = (name) => {
            const value = env[name] !== undefined ? env[name] : env[`npm_config_${name.toLowerCase()}`] !== undefined ? env[`npm_config_${name.toLowerCase()}`] : env[`npm_package_config_${name.toLowerCase()}`];
            if (value !== undefined && typeof value !== 'string')
                throw new Error(`${name} must be a string`);
            return value;
        };
        const explicit = options.executablePath !== undefined || Object.prototype.hasOwnProperty.call(env, overrideName);
        const override = options.executablePath !== undefined ? text(options.executablePath, 'executablePath') : explicit ? text(env[overrideName], overrideName) : undefined;
        if (fromEnv('PLAYWRIGHT_HOST_PLATFORM_OVERRIDE'))
            throw new Error('PLAYWRIGHT_HOST_PLATFORM_OVERRIDE cannot override the verified system identity');
        const actualPlatform = platform();
        const actualArch = arch();
        const actualRelease = release();
        const darwinMajor = Number(actualRelease.split('.')[0]);
        if (actualPlatform !== pin.platform || actualArch !== pin.arch || !Number.isInteger(darwinMajor) || darwinMajor < pin.minimumDarwinMajor)
            throw new Error(`Unsupported/unverified system ${actualPlatform}/${actualArch}/${actualRelease}; only the pinned macOS arm64 headless shell is available`);
        const installed = record(join(packageRoot, 'package.json'));
        const browserManifest = record(join(packageRoot, 'browsers.json'));
        const browser = Array.isArray(browserManifest.browsers) ? browserManifest.browsers.find((item) => !!item && typeof item === 'object' && 'name' in item && item.name === pin.browserName) : undefined;
        if (installed.name !== pin.packageName || installed.version !== pin.packageVersion || !browser || typeof browser !== 'object' || !('revision' in browser) || browser.revision !== pin.revision || !('browserVersion' in browser) || browser.browserVersion !== pin.browserVersion)
            throw new Error(`Installed package/manifest must be ${pin.packageName}@${pin.packageVersion}, revision ${pin.revision}, browser version ${pin.browserVersion}`);
        // Match Playwright environment precedence; relative caches use operation cwd, never INIT_CWD.
        const configured = fromEnv('PLAYWRIGHT_BROWSERS_PATH');
        const cache = configured === '0' ? join(packageRoot, '.local-browsers') : configured ? resolve(cwd, configured) : join(homedir(), 'Library/Caches/ms-playwright');
        const candidate = override !== undefined ? resolve(cwd, override) : join(cache, `chromium_headless_shell-${pin.revision}`, pin.directory, pin.executable);
        if (/\.app(?:[/\\]|$)/i.test(candidate))
            throw new Error('GUI .app browsers are not allowed');
        const executablePath = realpathSync(candidate);
        if (/\.app(?:[/\\]|$)/i.test(executablePath))
            throw new Error('GUI .app symlink targets are not allowed');
        const directory = dirname(executablePath);
        const installation = dirname(directory);
        if (basename(executablePath) !== pin.executable || basename(directory) !== pin.directory || basename(installation) !== `chromium_headless_shell-${pin.revision}`)
            throw new Error(`Executable must belong to the pinned complete headless installation layout (revision ${pin.revision})`);
        if (existsSync(join(dirname(installation), '__dirlock')))
            throw new Error('Playwright installation/download lock is active; retry after installation completes');
        regular(join(installation, 'INSTALLATION_COMPLETE'), false);
        regular(executablePath);
        accessSync(executablePath, constants.X_OK);
        nativeBinary(executablePath);
        const executableDigest = pin.files[pin.executable];
        if (executableDigest === undefined)
            throw new Error('The pin must cover the browser binary digest');
        if (hashFile(executablePath) !== executableDigest)
            throw new Error('Browser binary SHA-256 digest does not match the verified installation');
        for (const [name, digest] of Object.entries(pin.files)) {
            if (name === pin.executable)
                continue;
            const file = join(directory, name);
            regular(file);
            const contained = relative(directory, realpathSync(file));
            if (contained === '..' || contained.startsWith(`..${sep}`) || isAbsolute(contained))
                throw new Error(`Installation resource escapes the pinned directory: ${name}`);
            if (hashFile(file) !== digest)
                throw new Error(`Installation resource SHA-256 digest mismatch: ${name}`);
        }
        const version = execFileSync(executablePath, ['--version'], { encoding: 'utf8', timeout: 10_000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
        if (version !== `Google Chrome for Testing ${pin.browserVersion}` && version !== `Chromium ${pin.browserVersion}`)
            throw new Error(`Actual browser --version mismatch: expected ${pin.browserVersion}, received ${JSON.stringify(version)}`);
        return Object.freeze({
            kind: 'chromium-headless-shell', resolver: 'playwright-pinned-headless-shell', executablePath,
            packageName: pin.packageName, packageVersion: pin.packageVersion, browserRevision: pin.revision,
            browserVersion: pin.browserVersion, binarySha256: executableDigest, platform: pin.platform, arch: pin.arch,
            capabilities: Object.freeze(['dom', 'screenshot', 'isolated-context', 'isolated-download-directory']),
        });
    }
    catch (cause) {
        throw new HeadlessEngineError(`${overrideName ? `${overrideName}: ` : ''}Pinned Chromium headless shell unavailable: ${cause instanceof Error ? cause.message : String(cause)}. Install the adapter's pinned Playwright package and matching headless shell through its CLI. No GUI fallback.`, cause);
    }
}