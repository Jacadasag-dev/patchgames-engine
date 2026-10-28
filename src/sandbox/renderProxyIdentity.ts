const proxies = new WeakSet<object>();

/** Private ownership registry, independent of either Three renderer module. */
export function registerEngineRenderProxy(proxy: object): void { proxies.add(proxy); }
export function isEngineRenderProxy(proxy: object): boolean { return proxies.has(proxy); }
