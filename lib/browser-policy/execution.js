// Vendored from DeepSeek Harness `@deepseek-ai/dsh-browser-use`
// 0.2.1-alpha.4.browser-policy.1, execution.
//
// 为什么内联：官方从 DSH 0.2.2-rc.5 起不再发布 `@deepseek-ai/dsh-browser-use`
// （应用内 355 个官方包里已无此包，也无 `dsh-client-runtime` / `dsh-client-ui-slots`）。
// 继续依赖一个停发的包只能靠私有 tarball 副本，版本会永久漂移。本文件只取该包里
// **零第三方依赖的纯函数模块**，逻辑逐字保留，不引入任何官方内部 API。
//
// 上游许可：MIT（repository: github.com/deepseek-ai/deepseek-harness,
// packages/browser-use/browser-use）。改动本文件时请同步保持与上游等价。
//
// 浏览器执行请求的解析、策略解析与最终参数校验。
/** Operation-local browser mode resolution and final adapter-argument validation. */
/** Structured denial before browser resource acquisition or backend dispatch. */
export class BrowserExecutionError extends Error {
    /** Stable denial classification for adapter and tool diagnostics. */
    code;
    /** Exact request owner, absent when external JSON could not be decoded. */
    scope;
    constructor(code, spec, message) {
        super(message);
        this.name = 'BrowserExecutionError';
        this.code = code;
        this.scope = spec?.scope;
    }
}
/**
 * Brand an execution identity supplied by its Session or task-batch owner.
 * @param value - process-local or wire-decoded owner identity.
 * @returns the unchanged identity with its execution scope brand.
 */
export function BrowserExecutionScopeId(value) {
    return value;
}
function invalid(field) {
    throw new BrowserExecutionError('INVALID_BROWSER_EXECUTION_REQUEST', undefined, `Invalid browser execution request field: ${field}`);
}
function object(value, field) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        return invalid(field);
    return value;
}
function identity(value, field) {
    if (typeof value !== 'string' || value.trim().length === 0)
        return invalid(field);
    return BrowserExecutionScopeId(value);
}
function oneOf(value, choices, field) {
    for (const choice of choices)
        if (value === choice)
            return choice;
    return invalid(field);
}
/**
 * Decode untrusted JavaScript/CLI JSON before typed request resolution.
 * Unknown fields and values fail explicitly; this does not validate an engine descriptor.
 * @param value - externally supplied JSON request.
 * @returns the validated request with branded owner identities.
 * @throws BrowserExecutionError for missing or unsupported request fields.
 */
export function parseBrowserExecutionRequest(value) {
    const input = object(value, 'request');
    const keys = ['scope', 'purpose', 'mode', 'ownership', 'resourceOwnerId', 'capabilities'];
    for (const key of Object.keys(input))
        if (!keys.includes(key))
            invalid(key);
    const scope = object(input.scope, 'scope');
    for (const key of Object.keys(scope))
        if (key !== 'sessionId' && key !== 'taskId')
            invalid(`scope.${key}`);
    if (!Array.isArray(input.capabilities))
        return invalid('capabilities');
    const capabilities = input.capabilities.map((item) => oneOf(item, [
        'dom', 'screenshot', 'browser-extension', 'native-window',
        'isolated-context', 'isolated-download-directory', 'authenticated-state',
    ], 'capabilities'));
    const ownership = oneOf(input.ownership, ['owned-process', 'borrowed-connection', 'task-lease'], 'ownership');
    const resourceOwnerId = input.resourceOwnerId === undefined ? undefined : identity(input.resourceOwnerId, 'resourceOwnerId');
    if (ownership === 'task-lease' && resourceOwnerId === undefined)
        return invalid('resourceOwnerId');
    return Object.freeze({
        scope: Object.freeze({ sessionId: identity(scope.sessionId, 'scope.sessionId'), taskId: identity(scope.taskId, 'scope.taskId') }),
        purpose: oneOf(input.purpose, ['automation', 'capture', 'web-regression', 'interactive', 'desktop-regression'], 'purpose'),
        ownership, capabilities: Object.freeze(capabilities),
        ...input.mode === undefined ? {} : { mode: oneOf(input.mode, ['headless', 'headed', 'native'], 'mode') },
        ...resourceOwnerId === undefined ? {} : { resourceOwnerId },
    });
}
/**
 * Resolve purpose defaults and snapshot one request without storing global policy.
 * Automatic page work defaults to headless; interactive and desktop work stay visible.
 * @param request - explicit Session, task batch, ownership, purpose, and capabilities.
 * @returns an immutable operation-local specification, independent of file sandbox mode.
 */
export function resolveBrowserExecution(request) {
    const mode = request.mode ?? (request.purpose === 'desktop-regression' ? 'native'
        : request.purpose === 'interactive' ? 'headed' : 'headless');
    return Object.freeze({
        ...request, mode,
        scope: Object.freeze({ ...request.scope }),
        capabilities: Object.freeze([...request.capabilities]),
    });
}
/**
 * Reject unsupported capability requests before package discovery or resource acquisition.
 * @param spec - resolved operation-local request.
 * @param supported - capabilities implemented by the selected adapter.
 * @throws BrowserExecutionError when the requested mode or capabilities are unavailable.
 */
export function validateBrowserCapabilities(spec, supported) {
    if (spec.mode === 'headless' && spec.capabilities.some(value => value === 'browser-extension' || value === 'native-window')) {
        throw new BrowserExecutionError('UNSUPPORTED_BROWSER_CAPABILITY', spec, 'True headless execution does not support browser-extension or native-window; request headed/native explicitly instead of GUI fallback');
    }
    for (const capability of spec.capabilities) {
        if (!supported.includes(capability)) {
            throw new BrowserExecutionError('UNSUPPORTED_BROWSER_CAPABILITY', spec, `Browser adapter does not support ${capability}`);
        }
    }
}
/**
 * Reject mode, capability, ownership, and final launch-argument mismatches.
 * The adapter must independently verify installed package/version/binary identity;
 * this function compares that resolver's result, not arbitrary executable contents.
 * Call immediately before every actual launch or attachment, including direct callers.
 * @param spec - resolved operation-local request.
 * @param target - adapter-resolved engine and the exact final backend arguments.
 * @throws BrowserExecutionError when the backend cannot honor the request without fallback.
 */
export function validateBrowserExecution(spec, target) {
    const deny = (code, message) => {
        throw new BrowserExecutionError(code, spec, message);
    };
    validateBrowserCapabilities(spec, target.engine.capabilities);
    if ((target.kind === 'launch' && spec.ownership !== 'owned-process')
        || (target.kind === 'attach' && spec.ownership === 'owned-process')
        || (target.kind === 'native' && spec.ownership === 'borrowed-connection')) {
        deny('BROWSER_OWNERSHIP_MISMATCH', 'Launch requires owned-process; attachment requires borrowed-connection or task-lease; native requires owned-process or task-lease');
    }
    if (spec.ownership === 'task-lease') {
        if (spec.resourceOwnerId === undefined) {
            deny('BROWSER_OWNERSHIP_MISMATCH', 'A task-lease requires its browser resourceOwnerId and never owns the browser process');
        }
        if (target.kind === 'launch' || spec.resourceOwnerId !== target.resourceOwnerId) {
            deny('BROWSER_OWNERSHIP_MISMATCH', 'Task-lease resourceOwnerId differs from the adapter broker resource owner');
        }
    }
    if (target.kind === 'attach') {
        if (spec.mode !== 'headed' || target.engine.kind !== 'external-browser') {
            deny('BROWSER_MODE_MISMATCH', 'Browser attachment requires headed mode; it cannot guarantee headless or replace native desktop execution');
        }
        return;
    }
    if (target.kind === 'native') {
        if (spec.mode !== 'native' || target.engine.kind !== 'electron') {
            deny('BROWSER_MODE_MISMATCH', 'Native desktop execution requires native mode and its native engine');
        }
        return;
    }
    const { options, engine } = target;
    if (options.executablePath !== engine.executablePath) {
        deny('BROWSER_ENGINE_MISMATCH', 'Final executablePath differs from the adapter-resolved browser engine');
    }
    if (spec.mode === 'native') {
        deny('BROWSER_MODE_MISMATCH', 'A browser launch cannot replace a native desktop execution');
    }
    if (spec.mode === 'headless') {
        if (!options.headless || engine.kind !== 'chromium-headless-shell' || options.channel !== undefined) {
            deny('BROWSER_ENGINE_MISMATCH', 'True headless execution requires the resolved chromium-headless-shell and no channel override');
        }
        if (options.args.some(arg => arg === '--no-headless'
            || (arg.startsWith('--headless') && !['--headless', '--headless=new', '--headless=true'].includes(arg)))) {
            deny('BROWSER_MODE_MISMATCH', 'Final browser arguments contradict true headless execution');
        }
        if (options.args.some(arg => /^--(?:load-extension|disable-extensions-except|enable-unsafe-extension-debugging)(?:=|$)/u.test(arg))) {
            deny('UNSUPPORTED_BROWSER_CAPABILITY', 'Final browser arguments require extensions unavailable in true headless execution');
        }
    }
    else if (options.headless || engine.kind !== 'chromium' || options.args.some(arg => /^--headless(?:=|$)/u.test(arg))) {
        deny('BROWSER_MODE_MISMATCH', 'Headed execution must retain its normal visible window');
    }
}