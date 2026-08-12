// Cloudflare Worker - 简化版优选工具
// 仅保留优选域名、优选IP、GitHub、上报和节点生成功能
// 修复记录：已修正 VMess 协议下节点名称包含中文导致 Error 1101 的问题

// 默认配置
let customPreferredIPs = [];
let customPreferredDomains = [];
let epd = true;  // 启用优选域名
let epi = true;  // 启用优选IP
let egi = true;  // 启用自定义优选源
let ev = true;   // 启用VLESS协议
let et = false;  // 启用Trojan协议
let vm = false;  // 启用VMess协议
let scu = 'https://url.v1.mk/sub';  // 订阅转换地址
// ECH (Encrypted Client Hello)
let enableECH = false;
let customDNS = 'https://dns.joeyblog.eu.org/joeyblog';
let customECHDomain = 'cloudflare-ech.com';

// 默认优选域名列表
const directDomains = [
    { name: "cloudflare.182682.xyz", domain: "cloudflare.182682.xyz" },
    { domain: "freeyx.cloudflare88.eu.org" },
    { domain: "bestcf.top" },
    { domain: "cdn.2020111.xyz" },
    { domain: "cf.0sm.com" },
    { domain: "cf.090227.xyz" },
    { domain: "cf.zhetengsha.eu.org" },
    { domain: "cfip.1323123.xyz" },
    { domain: "cloudflare-ip.mofashi.ltd" },
    { domain: "cf.877771.xyz" },
    { domain: "xn--b6gac.eu.org" }
];

// 默认优选IP来源URL
const defaultIPURL = 'https://raw.githubusercontent.com/qwer-search/bestip/refs/heads/main/kejilandbestip.txt';

// ===== 全局优选源配置（KV） =====
// 推荐在 Cloudflare Workers -> Settings -> Bindings 中绑定一个 KV Namespace，变量名设为 C。
// 也兼容绑定名 YX_KV。日常修改通过网页写入 KV，无需重新部署 Worker。
// ADMIN_TOKEN 只需设置一次，用于保护网页里的“全局优选源设置”写入接口。
const KV_CONFIG_KEY = 'yx_auto:preferred_sources:v1';
const DEFAULT_PREFERRED_CONFIG = {
    ipv4Url: 'https://cc.755gaoyi.cc.cd/yx-ip.txt',
    ipv6Url: 'https://cc.755gaoyi.cc.cd/yx-ipv6.txt',
    extraUrls: '',
    ipv4Enabled: true,
    ipv6Enabled: true
};

function getKVBinding(env) {
    return env?.C || env?.YX_KV || null;
}

function parseBool(value, fallback = true) {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'boolean') return value;
    const normalized = String(value).trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
    return fallback;
}

function splitUrlList(value) {
    if (Array.isArray(value)) {
        return value.map(v => String(v).trim()).filter(Boolean);
    }
    return String(value || '')
        .split(/[\r\n,]+/)
        .map(v => v.trim())
        .filter(Boolean);
}

function isHttpUrl(value) {
    try {
        const u = new URL(String(value).trim());
        return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
        return false;
    }
}

function sanitizePreferredConfig(input = {}, fallback = DEFAULT_PREFERRED_CONFIG) {
    const base = {
        ipv4Url: String(fallback.ipv4Url || DEFAULT_PREFERRED_CONFIG.ipv4Url).trim(),
        ipv6Url: String(fallback.ipv6Url || DEFAULT_PREFERRED_CONFIG.ipv6Url).trim(),
        extraUrls: String(fallback.extraUrls || '').trim(),
        ipv4Enabled: parseBool(fallback.ipv4Enabled, true),
        ipv6Enabled: parseBool(fallback.ipv6Enabled, true)
    };

    const result = {
        ipv4Url: String(input.ipv4Url ?? base.ipv4Url).trim(),
        ipv6Url: String(input.ipv6Url ?? base.ipv6Url).trim(),
        extraUrls: Array.isArray(input.extraUrls)
            ? input.extraUrls.join('\n')
            : String(input.extraUrls ?? base.extraUrls).trim(),
        ipv4Enabled: parseBool(input.ipv4Enabled, base.ipv4Enabled),
        ipv6Enabled: parseBool(input.ipv6Enabled, base.ipv6Enabled)
    };

    if (!isHttpUrl(result.ipv4Url)) result.ipv4Url = base.ipv4Url;
    if (!isHttpUrl(result.ipv6Url)) result.ipv6Url = base.ipv6Url;

    result.extraUrls = splitUrlList(result.extraUrls)
        .filter(isHttpUrl)
        .join('\n');

    return result;
}

async function loadPreferredConfig(env) {
    // 环境变量只作为“初始/兜底”配置；KV 中的值优先级最高。
    const envFallback = sanitizePreferredConfig({
        ipv4Url: env?.YX_IPV4_URL || DEFAULT_PREFERRED_CONFIG.ipv4Url,
        ipv6Url: env?.YX_IPV6_URL || DEFAULT_PREFERRED_CONFIG.ipv6Url,
        extraUrls: env?.YX_EXTRA_URLS || DEFAULT_PREFERRED_CONFIG.extraUrls,
        ipv4Enabled: env?.YX_IPV4 ?? DEFAULT_PREFERRED_CONFIG.ipv4Enabled,
        ipv6Enabled: env?.YX_IPV6 ?? DEFAULT_PREFERRED_CONFIG.ipv6Enabled
    });

    const kv = getKVBinding(env);
    if (!kv) {
        return { ...envFallback, kvBound: false, source: 'env/default' };
    }

    try {
        const raw = await kv.get(KV_CONFIG_KEY, { cacheTtl: 30 });
        if (!raw) {
            return { ...envFallback, kvBound: true, source: 'env/default' };
        }
        const parsed = JSON.parse(raw);
        const config = sanitizePreferredConfig(parsed, envFallback);
        return { ...config, kvBound: true, source: 'kv' };
    } catch (error) {
        console.error('读取 KV 优选配置失败:', error);
        return { ...envFallback, kvBound: true, source: 'env/default' };
    }
}

function buildPreferredSourceSpec(config, ipv4Allowed = true, ipv6Allowed = true) {
    const urls = [];
    if (config.ipv4Enabled && ipv4Allowed && isHttpUrl(config.ipv4Url)) {
        urls.push(config.ipv4Url);
    }
    if (config.ipv6Enabled && ipv6Allowed && isHttpUrl(config.ipv6Url)) {
        urls.push(config.ipv6Url);
    }
    urls.push(...splitUrlList(config.extraUrls).filter(isHttpUrl));
    return [...new Set(urls)].join('\n');
}

function getAdminTokenFromRequest(request) {
    const auth = request.headers.get('Authorization') || '';
    const bearer = auth.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
    return (
        request.headers.get('X-Admin-Token') ||
        bearer ||
        new URL(request.url).searchParams.get('token') ||
        ''
    ).trim();
}

function isAdminAuthorized(request, env) {
    const expected = String(env?.ADMIN_TOKEN || '').trim();
    if (!expected) return false;
    return getAdminTokenFromRequest(request) === expected;
}

function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data, null, 2), {
        status,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0'
        }
    });
}

function configApiError(message, status = 400, extra = {}) {
    return jsonResponse({ success: false, error: message, ...extra }, status);
}

function validatePreferredConfigPayload(input) {
    const rawIpv4 = String(input?.ipv4Url || '').trim();
    const rawIpv6 = String(input?.ipv6Url || '').trim();
    const extras = splitUrlList(input?.extraUrls || '');

    if (!rawIpv4 || !isHttpUrl(rawIpv4)) {
        return { ok: false, error: 'IPv4 优选源 URL 无效，必须是 http/https 地址' };
    }
    if (!rawIpv6 || !isHttpUrl(rawIpv6)) {
        return { ok: false, error: 'IPv6 优选源 URL 无效，必须是 http/https 地址' };
    }
    const badExtra = extras.find(v => !isHttpUrl(v));
    if (badExtra) {
        return { ok: false, error: `附加优选源 URL 无效: ${badExtra}` };
    }

    return {
        ok: true,
        config: sanitizePreferredConfig({
            ipv4Url: rawIpv4,
            ipv6Url: rawIpv6,
            extraUrls: extras.join('\n'),
            ipv4Enabled: input?.ipv4Enabled,
            ipv6Enabled: input?.ipv6Enabled
        })
    };
}

async function handleAdminConfigApi(request, env) {
    const kv = getKVBinding(env);
    if (!kv) {
        return configApiError(
            '未绑定 KV。请在 Workers -> Settings -> Bindings 添加 KV Namespace，变量名建议设为 C。',
            503,
            { code: 'KV_NOT_BOUND' }
        );
    }
    if (!String(env?.ADMIN_TOKEN || '').trim()) {
        return configApiError(
            '未设置 ADMIN_TOKEN。请先在 Worker 环境变量/Secret 中设置一次 ADMIN_TOKEN，用于保护网页配置写入。',
            503,
            { code: 'ADMIN_TOKEN_NOT_SET' }
        );
    }
    if (!isAdminAuthorized(request, env)) {
        return configApiError('管理员 Token 不正确', 401, { code: 'UNAUTHORIZED' });
    }

    if (request.method === 'GET') {
        const config = await loadPreferredConfig(env);
        return jsonResponse({
            success: true,
            config: {
                ipv4Url: config.ipv4Url,
                ipv6Url: config.ipv6Url,
                extraUrls: config.extraUrls,
                ipv4Enabled: config.ipv4Enabled,
                ipv6Enabled: config.ipv6Enabled
            },
            source: config.source,
            kvBound: true
        });
    }

    if (request.method === 'POST') {
        let body;
        try {
            body = await request.json();
        } catch {
            return configApiError('请求 JSON 格式错误', 400);
        }
        const checked = validatePreferredConfigPayload(body);
        if (!checked.ok) return configApiError(checked.error, 400);

        try {
            await kv.put(KV_CONFIG_KEY, JSON.stringify({
                ...checked.config,
                updatedAt: new Date().toISOString()
            }));
        } catch (error) {
            return configApiError(`写入 KV 失败: ${error.message || error}`, 500);
        }

        return jsonResponse({
            success: true,
            message: '已保存到 KV',
            config: checked.config
        });
    }

    return configApiError('Method Not Allowed', 405);
}

async function handleAdminSourceTestApi(request, env) {
    const kv = getKVBinding(env);
    if (!kv) return configApiError('未绑定 KV', 503);
    if (!String(env?.ADMIN_TOKEN || '').trim()) {
        return configApiError('未设置 ADMIN_TOKEN', 503);
    }
    if (!isAdminAuthorized(request, env)) {
        return configApiError('管理员 Token 不正确', 401);
    }
    if (request.method !== 'POST') return configApiError('Method Not Allowed', 405);

    let body;
    try {
        body = await request.json();
    } catch {
        return configApiError('请求 JSON 格式错误', 400);
    }

    const checked = validatePreferredConfigPayload(body);
    if (!checked.ok) return configApiError(checked.error, 400);

    const urls = [];
    if (checked.config.ipv4Enabled) urls.push({ type: 'IPv4', url: checked.config.ipv4Url });
    if (checked.config.ipv6Enabled) urls.push({ type: 'IPv6', url: checked.config.ipv6Url });
    splitUrlList(checked.config.extraUrls).forEach((u, i) => {
        urls.push({ type: `附加${i + 1}`, url: u });
    });

    const results = [];
    for (const item of urls) {
        try {
            const list = await 请求优选API([item.url], '443', 5000);
            results.push({
                type: item.type,
                url: item.url,
                success: list.length > 0,
                count: list.length,
                sample: list.slice(0, 3)
            });
        } catch (error) {
            results.push({
                type: item.type,
                url: item.url,
                success: false,
                count: 0,
                error: error.message || String(error)
            });
        }
    }

    return jsonResponse({
        success: results.some(r => r.success),
        results
    });
}

function parsePreferredAddress(raw, defaultPort = 443) {
    let text = String(raw || '').trim();
    if (!text) return null;

    let remark = '';
    const hashIndex = text.indexOf('#');
    if (hashIndex >= 0) {
        remark = text.slice(hashIndex + 1).trim();
        text = text.slice(0, hashIndex).trim();
    }

    let host = '';
    let port = Number(defaultPort) || 443;

    if (text.startsWith('[')) {
        const match = text.match(/^\[([^\]]+)\](?::(\d+))?$/);
        if (!match) return null;
        host = match[1];
        if (match[2]) port = parseInt(match[2], 10);
    } else {
        const colonCount = (text.match(/:/g) || []).length;
        if (colonCount >= 2) {
            // 裸 IPv6：不猜测末尾数字是否为端口。自定义端口请写成 [IPv6]:端口。
            host = text;
        } else {
            const match = text.match(/^(.+?)(?::(\d+))?$/);
            if (!match) return null;
            host = match[1].trim();
            if (match[2]) port = parseInt(match[2], 10);
        }
    }

    if (!host || !Number.isFinite(port) || port < 1 || port > 65535) return null;
    return {
        ip: host.replace(/^\[|\]$/g, ''),
        port,
        name: remark || host.replace(/^\[|\]$/g, '')
    };
}


// UUID验证
function isValidUUID(str) {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    return uuidRegex.test(str);
}

// 从环境变量获取配置
function getConfigValue(key, defaultValue) {
    return defaultValue || '';
}

// 获取动态IP列表（支持IPv4/IPv6和运营商筛选）
async function fetchDynamicIPs(ipv4Enabled = true, ipv6Enabled = true, ispMobile = true, ispUnicom = true, ispTelecom = true) {
    const v4Url = "https://www.wetest.vip/page/cloudflare/address_v4.html";
    const v6Url = "https://www.wetest.vip/page/cloudflare/address_v6.html";
    let results = [];

    try {
        const fetchPromises = [];
        if (ipv4Enabled) {
            fetchPromises.push(fetchAndParseWetest(v4Url));
        } else {
            fetchPromises.push(Promise.resolve([]));
        }
        if (ipv6Enabled) {
            fetchPromises.push(fetchAndParseWetest(v6Url));
        } else {
            fetchPromises.push(Promise.resolve([]));
        }

        const [ipv4List, ipv6List] = await Promise.all(fetchPromises);
        results = [...ipv4List, ...ipv6List];
        
        // 按运营商筛选
        if (results.length > 0) {
            results = results.filter(item => {
                const isp = item.isp || '';
                if (isp.includes('移动') && !ispMobile) return false;
                if (isp.includes('联通') && !ispUnicom) return false;
                if (isp.includes('电信') && !ispTelecom) return false;
                return true;
            });
        }
        
        return results.length > 0 ? results : [];
    } catch (e) {
        return [];
    }
}

// 解析wetest页面
async function fetchAndParseWetest(url) {
    try {
        const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (!response.ok) return [];
        const html = await response.text();
        const results = [];
        const rowRegex = /<tr[\s\S]*?<\/tr>/g;
        const cellRegex = /<td data-label="线路名称">(.+?)<\/td>[\s\S]*?<td data-label="优选地址">([\d.:a-fA-F]+)<\/td>[\s\S]*?<td data-label="数据中心">(.+?)<\/td>/;

        let match;
        while ((match = rowRegex.exec(html)) !== null) {
            const rowHtml = match[0];
            const cellMatch = rowHtml.match(cellRegex);
            if (cellMatch && cellMatch[1] && cellMatch[2]) {
                const colo = cellMatch[3] ? cellMatch[3].trim().replace(/<.*?>/g, '') : '';
                results.push({
                    isp: cellMatch[1].trim().replace(/<.*?>/g, ''),
                    ip: cellMatch[2].trim(),
                    colo: colo
                });
            }
        }
        return results;
    } catch (error) {
        return [];
    }
}

// 整理成数组
async function 整理成数组(内容) {
    var 替换后的内容 = 内容.replace(/[	"'\r\n]+/g, ',').replace(/,+/g, ',');
    if (替换后的内容.charAt(0) == ',') 替换后的内容 = 替换后的内容.slice(1);
    if (替换后的内容.charAt(替换后的内容.length - 1) == ',') 替换后的内容 = 替换后的内容.slice(0, 替换后的内容.length - 1);
    const 地址数组 = 替换后的内容.split(',');
    return 地址数组;
}

// 请求优选API
async function 请求优选API(urls, 默认端口 = '443', 超时时间 = 3000) {
    if (!urls?.length) return [];
    const results = new Set();
    await Promise.allSettled(urls.map(async (url) => {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 超时时间);
            const response = await fetch(url, { signal: controller.signal });
            clearTimeout(timeoutId);
            let text = '';
            try {
                const buffer = await response.arrayBuffer();
                const contentType = (response.headers.get('content-type') || '').toLowerCase();
                const charset = contentType.match(/charset=([^\s;]+)/i)?.[1]?.toLowerCase() || '';

                // 根据 Content-Type 响应头判断编码优先级
                let decoders = ['utf-8', 'gb2312']; // 默认优先 UTF-8
                if (charset.includes('gb') || charset.includes('gbk') || charset.includes('gb2312')) {
                    decoders = ['gb2312', 'utf-8']; // 如果明确指定 GB 系编码，优先尝试 GB2312
                }

                // 尝试多种编码解码
                let decodeSuccess = false;
                for (const decoder of decoders) {
                    try {
                        const decoded = new TextDecoder(decoder).decode(buffer);
                        // 验证解码结果的有效性
                        if (decoded && decoded.length > 0 && !decoded.includes('\ufffd')) {
                            text = decoded;
                            decodeSuccess = true;
                            break;
                        } else if (decoded && decoded.length > 0) {
                            // 如果有替换字符 (U+FFFD)，说明编码不匹配，继续尝试下一个编码
                            continue;
                        }
                    } catch (e) {
                        // 该编码解码失败，尝试下一个
                        continue;
                    }
                }

                // 如果所有编码都失败或无效，尝试 response.text()
                if (!decodeSuccess) {
                    text = await response.text();
                }

                // 如果返回的是空或无效数据，返回
                if (!text || text.trim().length === 0) {
                    return;
                }
            } catch (e) {
                console.error('Failed to decode response:', e);
                return;
            }
            const lines = text.trim().split('\n').map(l => l.trim()).filter(l => l);
            const isCSV = lines.length > 1 && lines[0].includes(',');
            const IPV6_PATTERN = /^[^\[\]]*:[^\[\]]*:[^\[\]]/;
            if (!isCSV) {
                lines.forEach(line => {
                    const hashIndex = line.indexOf('#');
                    const [rawHostPart, remark] = hashIndex > -1
                        ? [line.substring(0, hashIndex).trim(), line.substring(hashIndex)]
                        : [line.trim(), ''];
                    const port = new URL(url).searchParams.get('port') || 默认端口;

                    if (!rawHostPart) return;

                    // 标准 [IPv6]:port
                    if (rawHostPart.startsWith('[')) {
                        const hasPort = /\]:(\d+)$/.test(rawHostPart);
                        results.add(hasPort ? `${rawHostPart}${remark}` : `${rawHostPart}:${port}${remark}`);
                        return;
                    }

                    const colonCount = (rawHostPart.match(/:/g) || []).length;
                    if (colonCount >= 2) {
                        // 裸 IPv6 一律加 []，避免把最后一个 hextet 错当端口。
                        results.add(`[${rawHostPart}]:${port}${remark}`);
                        return;
                    }

                    // IPv4 / 域名
                    const colonIndex = rawHostPart.lastIndexOf(':');
                    const hasPort = colonIndex > -1 && /^\d+$/.test(rawHostPart.substring(colonIndex + 1));
                    results.add(hasPort ? `${rawHostPart}${remark}` : `${rawHostPart}:${port}${remark}`);
                });
            } else {
                const headers = lines[0].split(',').map(h => h.trim());
                const dataLines = lines.slice(1);
                if (headers.includes('IP地址') && headers.includes('端口') && headers.includes('数据中心')) {
                    const ipIdx = headers.indexOf('IP地址'), portIdx = headers.indexOf('端口');
                    const remarkIdx = headers.indexOf('国家') > -1 ? headers.indexOf('国家') :
                        headers.indexOf('城市') > -1 ? headers.indexOf('城市') : headers.indexOf('数据中心');
                    const tlsIdx = headers.indexOf('TLS');
                    dataLines.forEach(line => {
                        const cols = line.split(',').map(c => c.trim());
                        if (tlsIdx !== -1 && cols[tlsIdx]?.toLowerCase() !== 'true') return;
                        const wrappedIP = IPV6_PATTERN.test(cols[ipIdx]) ? `[${cols[ipIdx]}]` : cols[ipIdx];
                        results.add(`${wrappedIP}:${cols[portIdx]}#${cols[remarkIdx]}`);
                    });
                } else if (headers.some(h => h.includes('IP')) && headers.some(h => h.includes('延迟')) && headers.some(h => h.includes('下载速度'))) {
                    const ipIdx = headers.findIndex(h => h.includes('IP'));
                    const delayIdx = headers.findIndex(h => h.includes('延迟'));
                    const speedIdx = headers.findIndex(h => h.includes('下载速度'));
                    const port = new URL(url).searchParams.get('port') || 默认端口;
                    dataLines.forEach(line => {
                        const cols = line.split(',').map(c => c.trim());
                        const wrappedIP = IPV6_PATTERN.test(cols[ipIdx]) ? `[${cols[ipIdx]}]` : cols[ipIdx];
                        results.add(`${wrappedIP}:${port}#CF优选 ${cols[delayIdx]}ms ${cols[speedIdx]}MB/s`);
                    });
                }
            }
        } catch (e) { }
    }));
    return Array.from(results);
}

// 从GitHub获取优选IP（保留原有功能，同时支持优选API）
async function fetchAndParseNewIPs(piu) {
    const url = piu || defaultIPURL;
    try {
        const response = await fetch(url);
        if (!response.ok) return [];
        const text = await response.text();
        const results = [];
        const lines = text.trim().replace(/\r/g, "").split('\n');
        const regex = /^([^:]+):(\d+)#(.*)$/;

        for (const line of lines) {
            const trimmedLine = line.trim();
            if (!trimmedLine) continue;
            const match = trimmedLine.match(regex);
            if (match) {
                results.push({
                    ip: match[1],
                    port: parseInt(match[2], 10),
                    name: match[3].trim() || match[1]
                });
            }
        }
        return results;
    } catch (error) {
        return [];
    }
}

// ===== 端口生成模式 =====
// fixed443: 所有节点统一使用 443 + TLS。
// source:   优先使用 TXT / CSV / API 中明确给出的端口；没有明确端口时使用 443。
// legacy:   兼容旧订阅地址，保持原有“无端口时生成 443 + 80”的行为。
const PORT_MODE_FIXED_443 = 'fixed443';
const PORT_MODE_SOURCE = 'source';
const PORT_MODE_LEGACY = 'legacy';
const CF_HTTP_PORTS_FOR_GENERATION = [80, 8080, 8880, 2052, 2082, 2086, 2095];
const CF_HTTPS_PORTS_FOR_GENERATION = [443, 2053, 2083, 2087, 2096, 8443];

function normalizePortMode(value) {
    const mode = String(value || '').trim().toLowerCase();
    if (['443', 'fixed443', 'fixed-443', 'fixed'].includes(mode)) return PORT_MODE_FIXED_443;
    if (['source', 'api', 'source-port', 'source_port', 'best'].includes(mode)) return PORT_MODE_SOURCE;
    return PORT_MODE_LEGACY;
}

function buildPortsForItem(item, disableNonTLS = false, portMode = PORT_MODE_LEGACY) {
    const mode = normalizePortMode(portMode);

    // 模式一：统一 443。无论优选源写了什么端口，最终节点都固定 443 + TLS。
    if (mode === PORT_MODE_FIXED_443) {
        return [{ port: 443, tls: true }];
    }

    // 模式二：源端口优先。TXT/CSV/API 有明确端口就保留；没有就按 443。
    if (mode === PORT_MODE_SOURCE) {
        const parsedPort = Number(item && item.port);
        const port = Number.isFinite(parsedPort) && parsedPort > 0 && parsedPort <= 65535 ? parsedPort : 443;
        if (CF_HTTPS_PORTS_FOR_GENERATION.includes(port)) {
            return [{ port, tls: true }];
        }
        if (CF_HTTP_PORTS_FOR_GENERATION.includes(port)) {
            return disableNonTLS ? [] : [{ port, tls: false }];
        }
        // 非 Cloudflare 标准端口保持旧逻辑：按 TLS 节点生成，方便自建/特殊入口继续使用。
        return [{ port, tls: true }];
    }

    // 旧订阅兼容模式：完全保持原逻辑。
    if (item && item.port) {
        const port = Number(item.port);
        if (CF_HTTPS_PORTS_FOR_GENERATION.includes(port)) {
            return [{ port, tls: true }];
        }
        if (CF_HTTP_PORTS_FOR_GENERATION.includes(port)) {
            return disableNonTLS ? [] : [{ port, tls: false }];
        }
        return [{ port, tls: true }];
    }

    const ports = [{ port: 443, tls: true }];
    if (!disableNonTLS) ports.push({ port: 80, tls: false });
    return ports;
}

// 生成VLESS链接
function generateLinksFromSource(list, user, workerDomain, disableNonTLS = false, customPath = '/', echConfig = null, portMode = PORT_MODE_LEGACY) {
    const CF_HTTP_PORTS = [80, 8080, 8880, 2052, 2082, 2086, 2095];
    const CF_HTTPS_PORTS = [443, 2053, 2083, 2087, 2096, 8443];
    const defaultHttpsPorts = [443];
    const defaultHttpPorts = disableNonTLS ? [] : [80];
    const links = [];
    const wsPath = customPath || '/';
    const proto = 'vless';

    list.forEach(item => {
        let nodeNameBase = item.isp ? item.isp.replace(/\s/g, '_') : (item.name || item.domain || item.ip);
        if (item.colo && item.colo.trim()) {
            nodeNameBase = `${nodeNameBase}-${item.colo.trim()}`;
        }
        const safeIP = item.ip.includes(':') ? `[${item.ip}]` : item.ip;
        
        const portsToGenerate = buildPortsForItem(item, disableNonTLS, portMode);

        portsToGenerate.forEach(({ port, tls }) => {
            if (tls) {
                const wsNodeName = `${nodeNameBase}-${port}-WS-TLS`;
                const wsParams = new URLSearchParams({ 
                    encryption: 'none', 
                    security: 'tls', 
                    sni: workerDomain, 
                    fp: 'chrome', 
                    type: 'ws', 
                    host: workerDomain, 
                    path: wsPath
                });
                if (echConfig) {
                    wsParams.set('alpn', 'h3,h2,http/1.1');
                    wsParams.set('ech', echConfig);
                }
                links.push(`${proto}://${user}@${safeIP}:${port}?${wsParams.toString()}#${encodeURIComponent(wsNodeName)}`);
            } else {
                const wsNodeName = `${nodeNameBase}-${port}-WS`;
                const wsParams = new URLSearchParams({
                    encryption: 'none',
                    security: 'none',
                    type: 'ws',
                    host: workerDomain,
                    path: wsPath
                });
                links.push(`${proto}://${user}@${safeIP}:${port}?${wsParams.toString()}#${encodeURIComponent(wsNodeName)}`);
            }
        });
    });
    return links;
}

// 生成Trojan链接
async function generateTrojanLinksFromSource(list, user, workerDomain, disableNonTLS = false, customPath = '/', echConfig = null, portMode = PORT_MODE_LEGACY) {
    const CF_HTTP_PORTS = [80, 8080, 8880, 2052, 2082, 2086, 2095];
    const CF_HTTPS_PORTS = [443, 2053, 2083, 2087, 2096, 8443];
    const defaultHttpsPorts = [443];
    const defaultHttpPorts = disableNonTLS ? [] : [80];
    const links = [];
    const wsPath = customPath || '/';
    const password = user;  // Trojan使用UUID作为密码

    list.forEach(item => {
        let nodeNameBase = item.isp ? item.isp.replace(/\s/g, '_') : (item.name || item.domain || item.ip);
        if (item.colo && item.colo.trim()) {
            nodeNameBase = `${nodeNameBase}-${item.colo.trim()}`;
        }
        const safeIP = item.ip.includes(':') ? `[${item.ip}]` : item.ip;
        
        const portsToGenerate = buildPortsForItem(item, disableNonTLS, portMode);

        portsToGenerate.forEach(({ port, tls }) => {
            if (tls) {
                const wsNodeName = `${nodeNameBase}-${port}-Trojan-WS-TLS`;
                const wsParams = new URLSearchParams({ 
                    security: 'tls', 
                    sni: workerDomain, 
                    fp: 'chrome', 
                    type: 'ws', 
                    host: workerDomain, 
                    path: wsPath
                });
                if (echConfig) {
                    wsParams.set('alpn', 'h3,h2,http/1.1');
                    wsParams.set('ech', echConfig);
                }
                links.push(`trojan://${password}@${safeIP}:${port}?${wsParams.toString()}#${encodeURIComponent(wsNodeName)}`);
            } else {
                const wsNodeName = `${nodeNameBase}-${port}-Trojan-WS`;
                const wsParams = new URLSearchParams({
                    security: 'none',
                    type: 'ws',
                    host: workerDomain,
                    path: wsPath
                });
                links.push(`trojan://${password}@${safeIP}:${port}?${wsParams.toString()}#${encodeURIComponent(wsNodeName)}`);
            }
        });
    });
    return links;
}

// 生成VMess链接 (已修复中文名导致1101报错的问题)
function generateVMessLinksFromSource(list, user, workerDomain, disableNonTLS = false, customPath = '/', echConfig = null, portMode = PORT_MODE_LEGACY) {
    const CF_HTTP_PORTS = [80, 8080, 8880, 2052, 2082, 2086, 2095];
    const CF_HTTPS_PORTS = [443, 2053, 2083, 2087, 2096, 8443];
    const defaultHttpsPorts = [443];
    const defaultHttpPorts = disableNonTLS ? [] : [80];
    const links = [];
    const wsPath = customPath || '/';

    list.forEach(item => {
        let nodeNameBase = item.isp ? item.isp.replace(/\s/g, '_') : (item.name || item.domain || item.ip);
        if (item.colo && item.colo.trim()) {
            nodeNameBase = `${nodeNameBase}-${item.colo.trim()}`;
        }
        const safeIP = item.ip.includes(':') ? `[${item.ip}]` : item.ip;
        
        const portsToGenerate = buildPortsForItem(item, disableNonTLS, portMode);

        portsToGenerate.forEach(({ port, tls }) => {
            const vmessConfig = {
                v: "2",
                ps: tls ? `${nodeNameBase}-${port}-VMess-WS-TLS` : `${nodeNameBase}-${port}-VMess-WS`,
                add: safeIP,
                port: port.toString(),
                id: user,
                aid: "0",
                scy: "auto",
                net: "ws",
                type: "none",
                host: workerDomain,
                path: wsPath,
                tls: tls ? "tls" : "none"
            };
            if (tls) {
                vmessConfig.sni = workerDomain;
                vmessConfig.fp = "chrome";
            }
            
            // 核心修复：处理中文编码，防止 btoa 报错
            const jsonStr = JSON.stringify(vmessConfig);
            const vmessBase64 = btoa(encodeURIComponent(jsonStr).replace(/%([0-9A-F]{2})/g,
                function toSolidBytes(match, p1) {
                    return String.fromCharCode('0x' + p1);
            }));
            
            links.push(`vmess://${vmessBase64}`);
        });
    });
    return links;
}

// 从GitHub IP生成链接（VLESS）
function generateLinksFromNewIPs(list, user, workerDomain, customPath = '/', echConfig = null) {
    const CF_HTTP_PORTS = [80, 8080, 8880, 2052, 2082, 2086, 2095];
    const CF_HTTPS_PORTS = [443, 2053, 2083, 2087, 2096, 8443];
    const links = [];
    const wsPath = customPath || '/';
    const proto = 'vless';
    const echSuffix = echConfig ? `&alpn=h3%2Ch2%2Chttp%2F1.1&ech=${encodeURIComponent(echConfig)}` : '';
    
    list.forEach(item => {
        const nodeName = item.name.replace(/\s/g, '_');
        const port = item.port;
        const rawIP = String(item.ip || '').replace(/^\[|\]$/g, '');
        const safeIP = rawIP.includes(':') ? `[${rawIP}]` : rawIP;
        
        if (CF_HTTPS_PORTS.includes(port)) {
            const wsNodeName = `${nodeName}-${port}-WS-TLS`;
            const link = `${proto}://${user}@${safeIP}:${port}?encryption=none&security=tls&sni=${workerDomain}&fp=chrome&type=ws&host=${workerDomain}&path=${wsPath}${echSuffix}#${encodeURIComponent(wsNodeName)}`;
            links.push(link);
        } else if (CF_HTTP_PORTS.includes(port)) {
            const wsNodeName = `${nodeName}-${port}-WS`;
            const link = `${proto}://${user}@${safeIP}:${port}?encryption=none&security=none&type=ws&host=${workerDomain}&path=${wsPath}#${encodeURIComponent(wsNodeName)}`;
            links.push(link);
        } else {
            const wsNodeName = `${nodeName}-${port}-WS-TLS`;
            const link = `${proto}://${user}@${safeIP}:${port}?encryption=none&security=tls&sni=${workerDomain}&fp=chrome&type=ws&host=${workerDomain}&path=${wsPath}${echSuffix}#${encodeURIComponent(wsNodeName)}`;
            links.push(link);
        }
    });
    return links;
}

// 生成订阅内容
async function handleSubscriptionRequest(request, user, customDomain, piu, ipv4Enabled, ipv6Enabled, ispMobile, ispUnicom, ispTelecom, evEnabled, etEnabled, vmEnabled, disableNonTLS, customPath, echConfig = null, featureFlags = {}) {
    const url = new URL(request.url);
    const finalLinks = [];
    const workerDomain = url.hostname;  // workerDomain始终是请求的hostname
    const nodeDomain = customDomain || url.hostname;  // 用户输入的域名用于生成节点时的host/sni
    const target = url.searchParams.get('target') || 'base64';
    const wsPath = customPath || '/';
    const epdEnabled = featureFlags.epd ?? epd;
    const epiEnabled = featureFlags.epi ?? epi;
    const egiEnabled = featureFlags.egi ?? egi;
    // pm=443 => 全部固定443；pm=source => 源端口优先；未传 pm 保持旧订阅兼容。
    const portMode = normalizePortMode(url.searchParams.get('pm') || url.searchParams.get('portMode'));

    async function addNodesFromList(list) {
        // 确保至少有一个协议被启用
        const hasProtocol = evEnabled || etEnabled || vmEnabled;
        const useVL = hasProtocol ? evEnabled : true;  // 如果没有选择任何协议，默认使用VLESS
        
        if (useVL) {
            finalLinks.push(...generateLinksFromSource(list, user, nodeDomain, disableNonTLS, wsPath, echConfig, portMode));
        }
        if (etEnabled) {
            finalLinks.push(...await generateTrojanLinksFromSource(list, user, nodeDomain, disableNonTLS, wsPath, echConfig, portMode));
        }
        if (vmEnabled) {
            finalLinks.push(...generateVMessLinksFromSource(list, user, nodeDomain, disableNonTLS, wsPath, echConfig, portMode));
        }
    }

    // 原生地址
    const nativeList = [{ ip: workerDomain, isp: '原生地址' }];
    await addNodesFromList(nativeList);

    // 优选域名
    if (epdEnabled) {
        const domainList = directDomains.map(d => ({ ip: d.domain, isp: d.name || d.domain }));
        await addNodesFromList(domainList);
    }

    // 优选IP
    if (epiEnabled) {
        try {
            const dynamicIPList = await fetchDynamicIPs(ipv4Enabled, ipv6Enabled, ispMobile, ispUnicom, ispTelecom);
            if (dynamicIPList.length > 0) {
                await addNodesFromList(dynamicIPList);
            }
        } catch (error) {
            console.error('获取动态IP失败:', error);
        }
    }

    // 自定义优选源（支持 KV 中同时配置 IPv4 / IPv6 / 多个附加 URL）
    if (egiEnabled) {
        try {
            const sourceSpec = String(piu || '').trim();
            if (sourceSpec) {
                const sourceItems = sourceSpec
                    .split(/[\r\n,]+/)
                    .map(v => v.trim())
                    .filter(Boolean);

                const apiUrls = [];
                const addressLines = [];
                for (const item of sourceItems) {
                    if (/^https?:\/\//i.test(item)) {
                        apiUrls.push(item);
                    } else {
                        addressLines.push(item);
                    }
                }

                if (apiUrls.length > 0) {
                    const fetched = await 请求优选API(apiUrls);
                    addressLines.push(...fetched);
                }

                const preferredList = addressLines
                    .map(item => parsePreferredAddress(item, 443))
                    .filter(Boolean);

                if (preferredList.length > 0) {
                    await addNodesFromList(preferredList);
                }
            }
        } catch (error) {
            console.error('获取自定义优选IP失败:', error);
        }
    }

    if (finalLinks.length === 0) {
        const errorRemark = "所有节点获取失败";
        const errorLink = `vless://00000000-0000-0000-0000-000000000000@127.0.0.1:80?encryption=none&security=none&type=ws&host=error.com&path=%2F#${encodeURIComponent(errorRemark)}`;
        finalLinks.push(errorLink);
    }

    let subscriptionContent;
    let contentType = 'text/plain; charset=utf-8';
    
    switch (target.toLowerCase()) {
        case 'clash':
        case 'clashr':
            subscriptionContent = generateClashConfig(finalLinks);
            contentType = 'text/yaml; charset=utf-8';
            break;
        case 'surge':
        case 'surge2':
        case 'surge3':
        case 'surge4':
            subscriptionContent = generateSurgeConfig(finalLinks);
            break;
        case 'quantumult':
        case 'quanx':
            subscriptionContent = generateQuantumultConfig(finalLinks);
            break;
        default:
            subscriptionContent = btoa(finalLinks.join('\n'));
    }
    
    return new Response(subscriptionContent, {
        headers: { 
            'Content-Type': contentType,
            'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
        },
    });
}

// 生成Clash配置（简化版，返回YAML格式）
function generateClashConfig(links) {
    let yaml = 'port: 7890\n';
    yaml += 'socks-port: 7891\n';
    yaml += 'allow-lan: false\n';
    yaml += 'mode: rule\n';
    yaml += 'log-level: info\n\n';
    yaml += 'proxies:\n';
    
    const proxyNames = [];
    links.forEach((link, index) => {
        const name = decodeURIComponent(link.split('#')[1] || `节点${index + 1}`);
        proxyNames.push(name);
        const server = link.match(/@([^:]+):(\d+)/)?.[1] || '';
        const port = link.match(/@[^:]+:(\d+)/)?.[1] || '443';
        const uuid = link.match(/vless:\/\/([^@]+)@/)?.[1] || '';
        const tls = link.includes('security=tls');
        const path = link.match(/path=([^&#]+)/)?.[1] || '/';
        const host = link.match(/host=([^&#]+)/)?.[1] || '';
        const sni = link.match(/sni=([^&#]+)/)?.[1] || '';
        const echParam = link.match(/[?&]ech=([^&#]+)/)?.[1];
        const echDomain = echParam ? decodeURIComponent(echParam).split('+')[0] : '';
        
        yaml += `  - name: ${name}\n`;
        yaml += `    type: vless\n`;
        yaml += `    server: ${server}\n`;
        yaml += `    port: ${port}\n`;
        yaml += `    uuid: ${uuid}\n`;
        yaml += `    tls: ${tls}\n`;
        yaml += `    network: ws\n`;
        yaml += `    ws-opts:\n`;
        yaml += `      path: ${path}\n`;
        yaml += `      headers:\n`;
        yaml += `        Host: ${host}\n`;
        if (sni) {
            yaml += `    servername: ${sni}\n`;
        }
        if (echDomain) {
            yaml += `    ech-opts:\n`;
            yaml += `      enable: true\n`;
            yaml += `      query-server-name: ${echDomain}\n`;
        }
    });
    
    yaml += '\nproxy-groups:\n';
    yaml += '  - name: PROXY\n';
    yaml += '    type: select\n';
    yaml += `    proxies: [${proxyNames.map(n => `'${n}'`).join(', ')}]\n`;
    yaml += '\nrules:\n';
    yaml += '  - DOMAIN-SUFFIX,local,DIRECT\n';
    yaml += '  - IP-CIDR,127.0.0.0/8,DIRECT\n';
    yaml += '  - GEOIP,CN,DIRECT\n';
    yaml += '  - MATCH,PROXY\n';
    
    return yaml;
}

// 生成Surge配置
function generateSurgeConfig(links) {
    let config = '[Proxy]\n';
    links.forEach(link => {
        const name = decodeURIComponent(link.split('#')[1] || '节点');
        config += `${name} = vless, ${link.match(/@([^:]+):(\d+)/)?.[1] || ''}, ${link.match(/@[^:]+:(\d+)/)?.[1] || '443'}, username=${link.match(/vless:\/\/([^@]+)@/)?.[1] || ''}, tls=${link.includes('security=tls')}, ws=true, ws-path=${link.match(/path=([^&#]+)/)?.[1] || '/'}, ws-headers=Host:${link.match(/host=([^&#]+)/)?.[1] || ''}\n`;
    });
    config += '\n[Proxy Group]\nPROXY = select, ' + links.map((_, i) => decodeURIComponent(links[i].split('#')[1] || `节点${i + 1}`)).join(', ') + '\n';
    return config;
}

// 生成Quantumult配置
function generateQuantumultConfig(links) {
    return btoa(links.join('\n'));
}

// 生成iOS 26风格的主页
function generateHomePage(scuValue, runtimeMeta = {}) {
    const scu = scuValue || 'https://url.v1.mk/sub';
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <meta name="apple-mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
    <title>服务器优选工具</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
            -webkit-tap-highlight-color: transparent;
        }
        
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'SF Pro Text', 'Helvetica Neue', Arial, sans-serif;
            background: linear-gradient(180deg, #f5f5f7 0%, #ffffff 50%, #fafafa 100%);
            color: #1d1d1f;
            min-height: 100vh;
            padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);
            overflow-x: hidden;
        }
        
        .container {
            max-width: 600px;
            margin: 0 auto;
            padding: 20px;
        }
        
        .header {
            text-align: center;
            padding: 48px 20px 32px;
        }
        
        .header h1 {
            font-size: 40px;
            font-weight: 700;
            letter-spacing: -0.3px;
            color: #1d1d1f;
            margin-bottom: 8px;
            line-height: 1.1;
        }
        
        .header p {
            font-size: 17px;
            color: #86868b;
            font-weight: 400;
            line-height: 1.5;
        }
        
        .card {
            background: rgba(255, 255, 255, 0.75);
            backdrop-filter: blur(30px) saturate(200%);
            -webkit-backdrop-filter: blur(30px) saturate(200%);
            border-radius: 24px;
            padding: 28px;
            margin-bottom: 20px;
            box-shadow: 0 4px 24px rgba(0, 0, 0, 0.06), 0 1px 3px rgba(0, 0, 0, 0.05);
            border: 0.5px solid rgba(0, 0, 0, 0.06);
            will-change: transform;
        }
        
        .form-group {
            margin-bottom: 24px;
        }
        
        .form-group:last-child {
            margin-bottom: 0;
        }
        
        .form-group label {
            display: block;
            font-size: 13px;
            font-weight: 600;
            color: #86868b;
            margin-bottom: 8px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }
        
        .form-group input,
        .form-group textarea {
            width: 100%;
            padding: 14px 16px;
            font-size: 17px;
            font-weight: 400;
            color: #1d1d1f;
            background: rgba(142, 142, 147, 0.12);
            border: 2px solid transparent;
            border-radius: 12px;
            outline: none;
            transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
            -webkit-appearance: none;
        }
        
        .form-group input:focus,
        .form-group textarea:focus {
            background: rgba(142, 142, 147, 0.16);
            border-color: #007AFF;
            transform: scale(1.005);
        }
        
        .form-group input::placeholder,
        .form-group textarea::placeholder {
            color: #86868b;
        }
        
        .form-group small {
            display: block;
            margin-top: 8px;
            color: #86868b;
            font-size: 13px;
            line-height: 1.4;
        }
        
        .list-item {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 16px 0;
            min-height: 52px;
            cursor: pointer;
            border-bottom: 0.5px solid rgba(0, 0, 0, 0.08);
            transition: background-color 0.15s ease;
        }
        
        .list-item:last-child {
            border-bottom: none;
        }
        
        .list-item:active {
            background-color: rgba(142, 142, 147, 0.08);
            margin: 0 -28px;
            padding-left: 28px;
            padding-right: 28px;
        }
        
        .list-item-label {
            font-size: 17px;
            font-weight: 400;
            color: #1d1d1f;
            flex: 1;
        }
        
        .list-item-description {
            font-size: 13px;
            color: #86868b;
            margin-top: 4px;
            line-height: 1.4;
        }
        
        .switch {
            position: relative;
            width: 51px;
            height: 31px;
            background: rgba(142, 142, 147, 0.3);
            border-radius: 16px;
            transition: background 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            cursor: pointer;
            flex-shrink: 0;
        }
        
        .switch.active {
            background: #34C759;
        }
        
        .switch::after {
            content: '';
            position: absolute;
            top: 2px;
            left: 2px;
            width: 27px;
            height: 27px;
            background: #ffffff;
            border-radius: 50%;
            transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            box-shadow: 0 2px 6px rgba(0, 0, 0, 0.15), 0 1px 2px rgba(0, 0, 0, 0.1);
        }
        
        .switch.active::after {
            transform: translateX(20px);
        }
        
        .btn {
            width: 100%;
            padding: 16px;
            font-size: 17px;
            font-weight: 600;
            color: #ffffff;
            background: #007AFF;
            border: none;
            border-radius: 14px;
            cursor: pointer;
            transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
            margin-top: 8px;
            -webkit-appearance: none;
            box-shadow: 0 4px 12px rgba(0, 122, 255, 0.25);
            will-change: transform;
        }
        
        .btn:hover {
            background: #0051D5;
            box-shadow: 0 6px 16px rgba(0, 122, 255, 0.3);
        }
        
        .btn:active {
            transform: scale(0.97);
            box-shadow: 0 2px 8px rgba(0, 122, 255, 0.2);
        }
        
        .btn:disabled {
            opacity: 0.5;
            cursor: not-allowed;
            transform: none;
        }
        
        .btn-secondary {
            background: rgba(142, 142, 147, 0.12);
            color: #007AFF;
            box-shadow: none;
        }
        
        .btn-secondary:hover {
            background: rgba(142, 142, 147, 0.16);
        }
        
        .btn-secondary:active {
            background: rgba(142, 142, 147, 0.2);
        }
        
        .result {
            margin-top: 20px;
            padding: 16px;
            background: rgba(142, 142, 147, 0.12);
            border-radius: 12px;
            font-size: 15px;
            color: #1d1d1f;
            word-break: break-all;
            display: none;
            line-height: 1.5;
        }
        
        .result.show {
            display: block;
        }
        
        .result-card {
            padding: 16px;
            background: rgba(255, 255, 255, 0.9);
            backdrop-filter: blur(20px);
            -webkit-backdrop-filter: blur(20px);
            border-radius: 12px;
            margin-bottom: 12px;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.06);
            border: 0.5px solid rgba(0, 0, 0, 0.06);
        }
        
        .result-url {
            margin-top: 12px;
            padding: 12px;
            background: rgba(0, 122, 255, 0.1);
            border-radius: 10px;
            font-size: 13px;
            color: #007aff;
            word-break: break-all;
            line-height: 1.5;
        }
        
        .copy-btn {
            margin-top: 8px;
            padding: 10px 16px;
            font-size: 15px;
            background: rgba(0, 122, 255, 0.1);
            color: #007aff;
            border: none;
            border-radius: 10px;
            cursor: pointer;
            transition: all 0.2s ease;
        }
        
        .copy-btn:active {
            background: rgba(0, 122, 255, 0.2);
            transform: scale(0.98);
        }
        
        .client-btn {
            padding: 12px 16px;
            font-size: 14px;
            font-weight: 500;
            color: #007AFF;
            background: rgba(0, 122, 255, 0.1);
            border: 1px solid rgba(0, 122, 255, 0.2);
            border-radius: 12px;
            cursor: pointer;
            transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
            -webkit-appearance: none;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            min-width: 0;
        }
        
        .client-btn:active {
            transform: scale(0.97);
            background: rgba(0, 122, 255, 0.2);
            border-color: rgba(0, 122, 255, 0.3);
        }
        
        .port-mode-btn.active {
            background: #007aff !important;
            border-color: #007aff !important;
            color: #ffffff !important;
            box-shadow: 0 6px 18px rgba(0, 122, 255, 0.18);
        }
        
        .checkbox-label {
            display: flex;
            align-items: center;
            cursor: pointer;
            font-size: 17px;
            font-weight: 400;
            user-select: none;
            -webkit-user-select: none;
            position: relative;
            z-index: 1;
            padding: 8px 0;
        }
        
        .checkbox-label input[type="checkbox"] {
            margin-right: 12px;
            width: 22px;
            height: 22px;
            cursor: pointer;
            flex-shrink: 0;
            position: relative;
            z-index: 2;
            -webkit-appearance: checkbox;
            appearance: checkbox;
        }
        
        .checkbox-label span {
            cursor: pointer;
            position: relative;
            z-index: 1;
        }
        
        @media (max-width: 480px) {
            .client-btn {
                font-size: 12px;
                padding: 10px 12px;
            }
            
            .header h1 {
                font-size: 34px;
            }
        }
        
        .footer {
            text-align: center;
            padding: 32px 20px;
            color: #86868b;
            font-size: 13px;
        }
        
        .footer a {
            color: #007AFF;
            text-decoration: none;
            font-weight: 500;
            transition: opacity 0.2s ease;
        }
        
        .footer a:active {
            opacity: 0.6;
        }
        
        @media (prefers-color-scheme: dark) {
            body {
                background: linear-gradient(180deg, #000000 0%, #1c1c1e 50%, #2c2c2e 100%);
                color: #f5f5f7;
            }
            
            .card {
                background: rgba(28, 28, 30, 0.75);
                border: 0.5px solid rgba(255, 255, 255, 0.12);
                box-shadow: 0 4px 24px rgba(0, 0, 0, 0.3), 0 1px 3px rgba(0, 0, 0, 0.2);
            }
            
            .form-group input,
            .form-group textarea {
                background: rgba(142, 142, 147, 0.2);
                color: #f5f5f7;
            }
            
            .form-group input:focus,
            .form-group textarea:focus {
                background: rgba(142, 142, 147, 0.25);
                border-color: #5ac8fa;
            }
            
            .list-item {
                border-bottom-color: rgba(255, 255, 255, 0.1);
            }
            
            .list-item:active {
                background-color: rgba(255, 255, 255, 0.08);
            }
            
            .list-item-label {
                color: #f5f5f7;
            }
            
            .switch {
                background: rgba(142, 142, 147, 0.4);
            }
            
            .switch.active {
                background: #30d158;
            }
            
            .switch::after {
                background: #ffffff;
            }
            
            .result {
                background: rgba(142, 142, 147, 0.2);
                color: #f5f5f7;
            }
            
            .result-card {
                background: rgba(28, 28, 30, 0.9);
                border-color: rgba(255, 255, 255, 0.1);
            }
            
            .checkbox-label span {
                color: #f5f5f7;
            }
            
            .client-btn {
                background: rgba(0, 122, 255, 0.15) !important;
                border-color: rgba(0, 122, 255, 0.3) !important;
                color: #5ac8fa !important;
            }
            
            .footer a {
                color: #5ac8fa !important;
            }
            
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>服务器优选工具</h1>
            <p>智能优选 • 一键生成</p>
        </div>
        
        <div class="card">
            <div class="form-group">
                <label>域名</label>
                <input type="text" id="domain" placeholder="请输入您的域名">
            </div>
            
            <div class="form-group">
                <label>UUID/Password</label>
                <input type="text" id="uuid" placeholder="请输入UUID或Password">
            </div>
            
            <div class="form-group">
                <label>WebSocket路径（可选）</label>
                <input type="text" id="customPath" placeholder="留空则使用默认路径 /" value="/">
                <small style="display: block; margin-top: 6px; color: #86868b; font-size: 13px;">自定义WebSocket路径，例如：/v2ray 或 /</small>
            </div>
            
            <div class="list-item" onclick="toggleSwitch('switchDomain')">
                <div>
                    <div class="list-item-label">启用优选域名</div>
                </div>
                <div class="switch active" id="switchDomain"></div>
            </div>
            
            <div class="list-item" onclick="toggleSwitch('switchIP')">
                <div>
                    <div class="list-item-label">启用优选IP</div>
                </div>
                <div class="switch active" id="switchIP"></div>
            </div>
            
            <div class="list-item" onclick="toggleSwitch('switchGitHub')">
                <div>
                    <div class="list-item-label">启用GitHub优选</div>
                </div>
                <div class="switch active" id="switchGitHub"></div>
            </div>
            
            <div class="form-group" id="githubUrlGroup" style="margin-top: 12px;">
                <label>临时优选源 URL（可选）</label>
                <input type="text" id="githubUrl" placeholder="留空则使用默认地址" style="font-size: 15px;">
                <small style="display: block; margin-top: 6px; color: #86868b; font-size: 13px;">临时覆盖 KV 优选源；留空则自动使用 KV 中配置的 IPv4/IPv6/附加优选源</small>
            </div>
            
            <div class="form-group" style="margin-top: 24px;">
                <label>协议选择</label>
                <div style="margin-top: 8px;">
                    <div class="list-item" onclick="toggleSwitch('switchVL')">
                        <div>
                            <div class="list-item-label">VLESS (vl)</div>
                        </div>
                        <div class="switch active" id="switchVL"></div>
                    </div>
                    <div class="list-item" onclick="toggleSwitch('switchTJ')">
                        <div>
                            <div class="list-item-label">Trojan (tj)</div>
                        </div>
                        <div class="switch" id="switchTJ"></div>
                    </div>
                    <div class="list-item" onclick="toggleSwitch('switchVM')">
                        <div>
                            <div class="list-item-label">VMess (vm)</div>
                        </div>
                        <div class="switch" id="switchVM"></div>
                    </div>
                </div>
            </div>
            
            <div class="form-group" style="margin-top: 24px;">
                <label>端口生成模式</label>
                <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-top:8px;">
                    <button type="button" id="portMode443" class="client-btn port-mode-btn active" onclick="generatePortModeSubscription('fixed443')">统一 443 订阅</button>
                    <button type="button" id="portModeSource" class="client-btn port-mode-btn" onclick="generatePortModeSubscription('source')">源端口优选订阅</button>
                </div>
                <small style="display:block;margin-top:8px;color:#86868b;font-size:13px;line-height:1.5;">
                    统一 443：所有优选地址最终都使用 443 + TLS。<br>
                    源端口优选：TXT / CSV / API 有明确端口就沿用；没有明确端口则使用 443。
                </small>
            </div>
            
            <div class="form-group" style="margin-top: 24px;">
                <label>客户端选择</label>
                <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 10px; margin-top: 8px;">
                    <button type="button" class="client-btn" onclick="generateClientLink('clash', 'CLASH')">CLASH</button>
                    <button type="button" class="client-btn" onclick="generateClientLink('clash', 'STASH')">STASH</button>
                    <button type="button" class="client-btn" onclick="generateClientLink('surge', 'SURGE')">SURGE</button>
                    <button type="button" class="client-btn" onclick="generateClientLink('sing-box', 'SING-BOX')">SING-BOX</button>
                    <button type="button" class="client-btn" onclick="generateClientLink('loon', 'LOON')">LOON</button>
                    <button type="button" class="client-btn" onclick="generateClientLink('quanx', 'QUANTUMULT X')" style="font-size: 13px;">QUANTUMULT X</button>
                    <button type="button" class="client-btn" onclick="generateClientLink('v2ray', 'V2RAY')">V2RAY</button>
                    <button type="button" class="client-btn" onclick="generateClientLink('v2ray', 'V2RAYNG')">V2RAYNG</button>
                    <button type="button" class="client-btn" onclick="generateClientLink('v2ray', 'NEKORAY')">NEKORAY</button>
                    <button type="button" class="client-btn" onclick="generateClientLink('v2ray', 'Shadowrocket')" style="font-size: 13px;">Shadowrocket</button>
                </div>
                <div class="result-url" id="clientSubscriptionUrl" style="display: none; margin-top: 12px; padding: 12px; background: rgba(0, 122, 255, 0.1); border-radius: 8px; font-size: 13px; color: #007aff; word-break: break-all;"></div>
            </div>
            
            <div class="form-group">
                <label>IP版本选择</label>
                <div style="display: flex; gap: 16px; margin-top: 8px;">
                    <label class="checkbox-label">
                        <input type="checkbox" id="ipv4Enabled" checked>
                        <span>IPv4</span>
                    </label>
                    <label class="checkbox-label">
                        <input type="checkbox" id="ipv6Enabled" checked>
                        <span>IPv6</span>
                    </label>
                </div>
            </div>
            
            <div class="form-group">
                <label>运营商选择</label>
                <div style="display: flex; gap: 16px; flex-wrap: wrap; margin-top: 8px;">
                    <label class="checkbox-label">
                        <input type="checkbox" id="ispMobile" checked>
                        <span>移动</span>
                    </label>
                    <label class="checkbox-label">
                        <input type="checkbox" id="ispUnicom" checked>
                        <span>联通</span>
                    </label>
                    <label class="checkbox-label">
                        <input type="checkbox" id="ispTelecom" checked>
                        <span>电信</span>
                    </label>
                </div>
            </div>
            
            <div class="list-item" onclick="toggleSwitch('switchTLS')" style="margin-top: 8px;">
                <div>
                    <div class="list-item-label">仅TLS节点</div>
                    <div class="list-item-description">启用后只生成带TLS的节点，不生成非TLS节点（如80端口）</div>
                </div>
                <div class="switch" id="switchTLS"></div>
            </div>
            
            <div class="list-item" onclick="toggleSwitch('switchECH')" style="margin-top: 8px;">
                <div>
                    <div class="list-item-label">ECH (Encrypted Client Hello)</div>
                    <div class="list-item-description">启用后节点链接将携带 ECH 参数，需客户端支持；开启时自动仅TLS</div>
                </div>
                <div class="switch" id="switchECH"></div>
            </div>
            <div class="form-group" id="echOptionsGroup" style="margin-top: 12px; display: none;">
                <label>ECH 自定义 DNS（可选）</label>
                <input type="text" id="customDNS" placeholder="例如: https://dns.joeyblog.eu.org/joeyblog" style="font-size: 14px;">
                <small style="display: block; margin-top: 6px; color: #86868b; font-size: 13px;">用于 ECH 配置查询的 DoH 地址</small>
                <label style="margin-top: 12px; display: block;">ECH 域名（可选）</label>
                <input type="text" id="customECHDomain" placeholder="例如: cloudflare-ech.com" style="font-size: 14px;">
            </div>
        </div>
        
        <div class="card" id="globalPreferredSettings">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:18px;">
                <div>
                    <div class="list-item-label" style="font-size:22px;font-weight:700;">全局优选源设置</div>
                    <div class="list-item-description" style="margin-top:6px;">
                        保存到 Workers KV，之后修改优选源无需重新部署 Worker
                    </div>
                </div>
            </div>

            <div style="padding:12px 14px;border-radius:12px;background:rgba(142,142,147,.10);margin-bottom:20px;font-size:13px;line-height:1.6;color:#86868b;">
                KV绑定：${runtimeMeta.kvBound ? '已检测到' : '未检测到'}　
                管理员保护：${runtimeMeta.adminTokenConfigured ? '已设置 ADMIN_TOKEN' : '未设置 ADMIN_TOKEN'}
                <br>建议 KV Binding 变量名使用 <strong>C</strong>（也兼容 YX_KV）。
            </div>

            <div class="form-group">
                <label>管理员 Token</label>
                <input type="password" id="adminToken" autocomplete="current-password" placeholder="输入 ADMIN_TOKEN 后加载/保存">
                <small>Token 只保存在当前浏览器 session，不会写入 KV。</small>
            </div>

            <div class="form-group">
                <label>IPv4 优选源 URL</label>
                <input type="url" id="kvIpv4Url" placeholder="https://cc.755gaoyi.cc.cd/yx-ip.txt">
            </div>

            <div class="form-group">
                <label>IPv6 优选源 URL</label>
                <input type="url" id="kvIpv6Url" placeholder="https://cc.755gaoyi.cc.cd/yx-ipv6.txt">
            </div>

            <div class="form-group">
                <label>附加优选源 URL（可选）</label>
                <textarea id="kvExtraUrls" rows="4" placeholder="每行一个 URL，也支持逗号分隔"></textarea>
                <small>可继续添加 JP / HK / US 等额外优选源。</small>
            </div>

            <div class="form-group">
                <label>全局 IP 源开关</label>
                <div style="display:flex;gap:18px;flex-wrap:wrap;margin-top:8px;">
                    <label class="checkbox-label">
                        <input type="checkbox" id="kvIpv4Enabled" checked>
                        <span>启用 IPv4 优选源</span>
                    </label>
                    <label class="checkbox-label">
                        <input type="checkbox" id="kvIpv6Enabled" checked>
                        <span>启用 IPv6 优选源</span>
                    </label>
                </div>
            </div>

            <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;">
                <button type="button" class="btn btn-secondary" style="margin-top:0;" onclick="loadGlobalPreferredConfig()">加载</button>
                <button type="button" class="btn btn-secondary" style="margin-top:0;" onclick="testGlobalPreferredSources()">测试</button>
                <button type="button" class="btn" style="margin-top:0;" onclick="saveGlobalPreferredConfig()">保存到 KV</button>
            </div>
            <div class="result" id="kvConfigStatus" style="display:none;margin-top:14px;"></div>
        </div>

        <div class="footer">
            <p>简化版优选工具 • 仅用于节点生成</p>
            <div style="margin-top: 20px; display: flex; justify-content: center; gap: 24px; flex-wrap: wrap;">
                <a href="https://github.com/byJoey/yx-auto" target="_blank" style="color: #007aff; text-decoration: none; font-size: 15px; font-weight: 500;">GitHub 项目</a>
                <a href="https://www.youtube.com/@joeyblog" target="_blank" style="color: #007aff; text-decoration: none; font-size: 15px; font-weight: 500;">YouTube @joeyblog</a>
            </div>
        </div>
    </div>
    
    <script>
        let switches = {
            switchDomain: true,
            switchIP: true,
            switchGitHub: true,
            switchVL: true,
            switchTJ: false,
            switchVM: false,
            switchTLS: false,
            switchECH: false
        };
        
        // 默认使用“统一443”，更适合主要承载流量的 VPS；可随时切换为“源端口优选”。
        let selectedPortMode = 'fixed443';

        function setPortMode(mode) {
            selectedPortMode = mode === 'source' ? 'source' : 'fixed443';
            const fixedBtn = document.getElementById('portMode443');
            const sourceBtn = document.getElementById('portModeSource');
            if (fixedBtn) fixedBtn.classList.toggle('active', selectedPortMode === 'fixed443');
            if (sourceBtn) sourceBtn.classList.toggle('active', selectedPortMode === 'source');
        }
        
        function toggleSwitch(id) {
            const switchEl = document.getElementById(id);
            switches[id] = !switches[id];
            switchEl.classList.toggle('active');
            if (id === 'switchECH') {
                const echOpt = document.getElementById('echOptionsGroup');
                if (echOpt) echOpt.style.display = switches.switchECH ? 'block' : 'none';
                if (switches.switchECH && !switches.switchTLS) {
                    switches.switchTLS = true;
                    const tlsEl = document.getElementById('switchTLS');
                    if (tlsEl) tlsEl.classList.add('active');
                }
            }
        }
        
        
        function kvStatus(message, isError) {
            const el = document.getElementById('kvConfigStatus');
            if (!el) return;
            el.style.display = 'block';
            el.style.color = isError ? '#ff453a' : '';
            el.textContent = message;
        }

        function getAdminToken() {
            const input = document.getElementById('adminToken');
            const token = (input && input.value || '').trim();
            if (token) sessionStorage.setItem('yx_auto_admin_token', token);
            return token;
        }

        function collectPreferredConfigForm() {
            return {
                ipv4Url: (document.getElementById('kvIpv4Url').value || '').trim(),
                ipv6Url: (document.getElementById('kvIpv6Url').value || '').trim(),
                extraUrls: (document.getElementById('kvExtraUrls').value || '').trim(),
                ipv4Enabled: document.getElementById('kvIpv4Enabled').checked,
                ipv6Enabled: document.getElementById('kvIpv6Enabled').checked
            };
        }

        function fillPreferredConfigForm(config) {
            if (!config) return;
            document.getElementById('kvIpv4Url').value = config.ipv4Url || '';
            document.getElementById('kvIpv6Url').value = config.ipv6Url || '';
            document.getElementById('kvExtraUrls').value = config.extraUrls || '';
            document.getElementById('kvIpv4Enabled').checked = config.ipv4Enabled !== false;
            document.getElementById('kvIpv6Enabled').checked = config.ipv6Enabled !== false;
        }

        async function adminApi(path, options) {
            const token = getAdminToken();
            if (!token) throw new Error('请先输入 ADMIN_TOKEN');
            const headers = Object.assign(
                { 'X-Admin-Token': token },
                options && options.headers ? options.headers : {}
            );
            const response = await fetch(path, Object.assign({}, options || {}, { headers }));
            const data = await response.json().catch(() => ({ success: false, error: '服务器返回格式错误' }));
            if (!response.ok || !data.success) {
                throw new Error(data.error || ('HTTP ' + response.status));
            }
            return data;
        }

        async function loadGlobalPreferredConfig() {
            kvStatus('正在读取 KV 配置…', false);
            try {
                const data = await adminApi('/api/admin/config', { method: 'GET' });
                fillPreferredConfigForm(data.config);
                kvStatus('已加载。当前来源：' + (data.source === 'kv' ? 'KV' : '环境变量/默认值'), false);
            } catch (error) {
                kvStatus(error.message || String(error), true);
            }
        }

        async function saveGlobalPreferredConfig() {
            kvStatus('正在写入 KV…', false);
            try {
                const data = await adminApi('/api/admin/config', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(collectPreferredConfigForm())
                });
                fillPreferredConfigForm(data.config);
                kvStatus('保存成功。新的订阅请求会读取 KV 配置；不同 Cloudflare 节点同步可能有短暂延迟。', false);
            } catch (error) {
                kvStatus(error.message || String(error), true);
            }
        }

        async function testGlobalPreferredSources() {
            kvStatus('正在测试优选源…', false);
            try {
                const data = await adminApi('/api/admin/test-sources', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(collectPreferredConfigForm())
                });
                const lines = (data.results || []).map(item => {
                    const status = item.success ? '✓' : '✗';
                    const detail = item.success ? (item.count + ' 条') : (item.error || '没有解析到地址');
                    return status + ' ' + item.type + '：' + detail;
                });
                kvStatus(lines.join('\\n') || '没有可测试的优选源', !data.success);
                const statusEl = document.getElementById('kvConfigStatus');
                if (statusEl) statusEl.style.whiteSpace = 'pre-wrap';
            } catch (error) {
                kvStatus(error.message || String(error), true);
            }
        }

        window.addEventListener('DOMContentLoaded', () => {
            const savedToken = sessionStorage.getItem('yx_auto_admin_token') || '';
            const tokenEl = document.getElementById('adminToken');
            if (tokenEl && savedToken) {
                tokenEl.value = savedToken;
                loadGlobalPreferredConfig();
            }
        });

        // 订阅转换地址（从服务器注入）
        const SUB_CONVERTER_URL = "${ scu }";
        
        function tryOpenApp(schemeUrl, fallbackCallback, timeout) {
            timeout = timeout || 2500;
            let appOpened = false;
            let callbackExecuted = false;
            const startTime = Date.now();
            
            const blurHandler = () => {
                const elapsed = Date.now() - startTime;
                if (elapsed < 3000 && !callbackExecuted) {
                    appOpened = true;
                }
            };
            
            window.addEventListener('blur', blurHandler);
            
            const hiddenHandler = () => {
                const elapsed = Date.now() - startTime;
                if (elapsed < 3000 && !callbackExecuted) {
                    appOpened = true;
                }
            };
            
            document.addEventListener('visibilitychange', hiddenHandler);
            
            const iframe = document.createElement('iframe');
            iframe.style.display = 'none';
            iframe.style.width = '1px';
            iframe.style.height = '1px';
            iframe.src = schemeUrl;
            document.body.appendChild(iframe);
            
            setTimeout(() => {
                if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
                window.removeEventListener('blur', blurHandler);
                document.removeEventListener('visibilitychange', hiddenHandler);
                
                if (!callbackExecuted) {
                    callbackExecuted = true;
                    if (!appOpened && fallbackCallback) {
                        fallbackCallback();
                    }
                }
            }, timeout);
        }
        
        function buildSubscriptionUrl(portMode = selectedPortMode) {
            const domain = document.getElementById('domain').value.trim();
            const uuid = document.getElementById('uuid').value.trim();
            const customPath = document.getElementById('customPath').value.trim() || '/';
            
            if (!domain || !uuid) {
                alert('请先填写域名和UUID/Password');
                return '';
            }
            
            if (!switches.switchVL && !switches.switchTJ && !switches.switchVM) {
                alert('请至少选择一个协议（VLESS、Trojan或VMess）');
                return '';
            }
            
            const ipv4Enabled = document.getElementById('ipv4Enabled').checked;
            const ipv6Enabled = document.getElementById('ipv6Enabled').checked;
            const ispMobile = document.getElementById('ispMobile').checked;
            const ispUnicom = document.getElementById('ispUnicom').checked;
            const ispTelecom = document.getElementById('ispTelecom').checked;
            const githubUrl = document.getElementById('githubUrl').value.trim();
            
            const currentUrl = new URL(window.location.href);
            const baseUrl = currentUrl.origin;
            const pm = portMode === 'source' ? 'source' : '443';
            let subscriptionUrl = \`\${baseUrl}/\${uuid}/sub?domain=\${encodeURIComponent(domain)}&epd=\${switches.switchDomain ? 'yes' : 'no'}&epi=\${switches.switchIP ? 'yes' : 'no'}&egi=\${switches.switchGitHub ? 'yes' : 'no'}&pm=\${pm}\`;
            
            if (githubUrl) subscriptionUrl += \`&piu=\${encodeURIComponent(githubUrl)}\`;
            if (switches.switchVL) subscriptionUrl += '&ev=yes';
            if (switches.switchTJ) subscriptionUrl += '&et=yes';
            if (switches.switchVM) subscriptionUrl += '&mess=yes';
            if (!ipv4Enabled) subscriptionUrl += '&ipv4=no';
            if (!ipv6Enabled) subscriptionUrl += '&ipv6=no';
            if (!ispMobile) subscriptionUrl += '&ispMobile=no';
            if (!ispUnicom) subscriptionUrl += '&ispUnicom=no';
            if (!ispTelecom) subscriptionUrl += '&ispTelecom=no';
            
            if (switches.switchTLS) subscriptionUrl += '&dkby=yes';
            if (switches.switchECH) {
                subscriptionUrl += '&ech=yes';
                const dnsVal = document.getElementById('customDNS') && document.getElementById('customDNS').value.trim();
                if (dnsVal) subscriptionUrl += \`&customDNS=\${encodeURIComponent(dnsVal)}\`;
                const domainVal = document.getElementById('customECHDomain') && document.getElementById('customECHDomain').value.trim();
                if (domainVal) subscriptionUrl += \`&customECHDomain=\${encodeURIComponent(domainVal)}\`;
            }
            if (customPath && customPath !== '/') subscriptionUrl += \`&path=\${encodeURIComponent(customPath)}\`;
            return subscriptionUrl;
        }

        function showAndCopySubscriptionUrl(subscriptionUrl, label) {
            if (!subscriptionUrl) return;
            const urlElement = document.getElementById('clientSubscriptionUrl');
            if (urlElement) {
                urlElement.textContent = subscriptionUrl;
                urlElement.style.display = 'block';
            }
            navigator.clipboard.writeText(subscriptionUrl).then(() => {
                alert(label + ' 已生成并复制');
            }).catch(() => {
                // HTTPS/浏览器权限限制时仍然把地址显示出来，方便手动复制。
            });
        }

        function generatePortModeSubscription(mode) {
            setPortMode(mode);
            const subscriptionUrl = buildSubscriptionUrl(selectedPortMode);
            if (!subscriptionUrl) return;
            showAndCopySubscriptionUrl(
                subscriptionUrl,
                selectedPortMode === 'source' ? '源端口优选订阅' : '统一443订阅'
            );
        }
        
        function generateClientLink(clientType, clientName) {
            const subscriptionUrl = buildSubscriptionUrl(selectedPortMode);
            if (!subscriptionUrl) return;
            
            let finalUrl = subscriptionUrl;
            let schemeUrl = '';
            let displayName = clientName || '';
            
            if (clientType === 'v2ray') {
                finalUrl = subscriptionUrl;
                const urlElement = document.getElementById('clientSubscriptionUrl');
                urlElement.textContent = finalUrl;
                urlElement.style.display = 'block';
                
                if (clientName === 'V2RAY') {
                    navigator.clipboard.writeText(finalUrl).then(() => {
                        alert(displayName + ' 订阅链接已复制');
                    });
                } else if (clientName === 'Shadowrocket') {
                    schemeUrl = 'shadowrocket://add/' + encodeURIComponent(finalUrl);
                    tryOpenApp(schemeUrl, () => {
                        navigator.clipboard.writeText(finalUrl).then(() => {
                            alert(displayName + ' 订阅链接已复制');
                        });
                    });
                } else if (clientName === 'V2RAYNG') {
                    schemeUrl = 'v2rayng://install?url=' + encodeURIComponent(finalUrl);
                    tryOpenApp(schemeUrl, () => {
                        navigator.clipboard.writeText(finalUrl).then(() => {
                            alert(displayName + ' 订阅链接已复制');
                        });
                    });
                } else if (clientName === 'NEKORAY') {
                    schemeUrl = 'nekoray://install-config?url=' + encodeURIComponent(finalUrl);
                    tryOpenApp(schemeUrl, () => {
                        navigator.clipboard.writeText(finalUrl).then(() => {
                            alert(displayName + ' 订阅链接已复制');
                        });
                    });
                }
            } else {
                const encodedUrl = encodeURIComponent(subscriptionUrl);
                finalUrl = SUB_CONVERTER_URL + '?target=' + clientType + '&url=' + encodedUrl + '&insert=false&emoji=true&list=false&xudp=false&udp=false&tfo=false&expand=true&scv=false&fdn=false&new_name=true';
                
                const urlElement = document.getElementById('clientSubscriptionUrl');
                urlElement.textContent = finalUrl;
                urlElement.style.display = 'block';
                
                if (clientType === 'clash') {
                    if (clientName === 'STASH') {
                        schemeUrl = 'stash://install?url=' + encodeURIComponent(finalUrl);
                        displayName = 'STASH';
                    } else {
                        schemeUrl = 'clash://install-config?url=' + encodeURIComponent(finalUrl);
                        displayName = 'CLASH';
                    }
                } else if (clientType === 'surge') {
                    schemeUrl = 'surge:///install-config?url=' + encodeURIComponent(finalUrl);
                    displayName = 'SURGE';
                } else if (clientType === 'sing-box') {
                    schemeUrl = 'sing-box://install-config?url=' + encodeURIComponent(finalUrl);
                    displayName = 'SING-BOX';
                } else if (clientType === 'loon') {
                    schemeUrl = 'loon://install?url=' + encodeURIComponent(finalUrl);
                    displayName = 'LOON';
                } else if (clientType === 'quanx') {
                    schemeUrl = 'quantumult-x://install-config?url=' + encodeURIComponent(finalUrl);
                    displayName = 'QUANTUMULT X';
                }
                
                if (schemeUrl) {
                    tryOpenApp(schemeUrl, () => {
                        navigator.clipboard.writeText(finalUrl).then(() => {
                            alert(displayName + ' 订阅链接已复制');
                        });
                    });
                } else {
                    navigator.clipboard.writeText(finalUrl).then(() => {
                        alert(displayName + ' 订阅链接已复制');
                    });
                }
            }
        }
    </script>
</body>
</html>`;
}

// 主处理函数
export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const path = url.pathname;
        
        // 主页
        if (path === '/' || path === '') {
            const scuValue = env?.scu || scu;
            return new Response(generateHomePage(scuValue, {
                kvBound: Boolean(getKVBinding(env)),
                adminTokenConfigured: Boolean(String(env?.ADMIN_TOKEN || '').trim())
            }), {
                headers: { 'Content-Type': 'text/html; charset=utf-8' }
            });
        }

        // 网页全局优选源配置 API（保存到 Workers KV）
        if (path === '/api/admin/config') {
            return await handleAdminConfigApi(request, env);
        }
        if (path === '/api/admin/test-sources') {
            return await handleAdminSourceTestApi(request, env);
        }
        
        // 测试优选API API: /test-optimize-api?url=xxx&port=443
        if (path === '/test-optimize-api') {
            if (request.method === 'OPTIONS') {
                return new Response(null, {
                    headers: {
                        'Access-Control-Allow-Origin': '*',
                        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
                        'Access-Control-Allow-Headers': 'Content-Type'
                    }
                });
            }
            
            const apiUrl = url.searchParams.get('url');
            const port = url.searchParams.get('port') || '443';
            const timeout = parseInt(url.searchParams.get('timeout') || '3000');
            
            if (!apiUrl) {
                return new Response(JSON.stringify({ 
                    success: false, 
                    error: '缺少url参数' 
                }), {
                    status: 400,
                    headers: { 
                        'Content-Type': 'application/json; charset=utf-8',
                        'Access-Control-Allow-Origin': '*'
                    }
                });
            }
            
            try {
                const results = await 请求优选API([apiUrl], port, timeout);
                return new Response(JSON.stringify({ 
                    success: true, 
                    results: results,
                    total: results.length,
                    message: `成功获取 ${results.length} 个优选IP`
                }, null, 2), {
                    headers: { 
                        'Content-Type': 'application/json; charset=utf-8',
                        'Access-Control-Allow-Origin': '*'
                    }
                });
            } catch (error) {
                return new Response(JSON.stringify({ 
                    success: false, 
                    error: error.message 
                }), {
                    status: 500,
                    headers: { 
                        'Content-Type': 'application/json; charset=utf-8',
                        'Access-Control-Allow-Origin': '*'
                    }
                });
            }
        }
        
        // 订阅请求格式: /{UUID或Password}/sub?domain=xxx&epd=yes&epi=yes&egi=yes&pm=443|source
        const pathMatch = path.match(/^\/([^\/]+)\/sub$/);
        if (pathMatch) {
            const uuid = pathMatch[1];
            
            const domain = url.searchParams.get('domain');
            if (!domain) {
                return new Response('缺少域名参数', { status: 400 });
            }
            
            // 从 URL + KV 获取配置。
            // URL 可继续临时关闭功能；全局优选源地址/开关由 KV 管理，无需重新部署。
            const epdEnabled = url.searchParams.get('epd') !== 'no';
            const epiEnabled = url.searchParams.get('epi') !== 'no';
            const egiEnabled = url.searchParams.get('egi') !== 'no';

            const preferredConfig = await loadPreferredConfig(env);

            // 全局 KV 开关优先：KV 关闭后，URL 仍可进一步关闭。
            const ipv4Enabled = preferredConfig.ipv4Enabled && url.searchParams.get('ipv4') !== 'no';
            const ipv6Enabled = preferredConfig.ipv6Enabled && url.searchParams.get('ipv6') !== 'no';

            // piu 参数仍保留最高优先级，便于临时测试；未传 piu 时使用 KV 中的多个优选源。
            const piuOverride = url.searchParams.get('piu');
            const piu = piuOverride || buildPreferredSourceSpec(preferredConfig, ipv4Enabled, ipv6Enabled) || defaultIPURL;

            // 协议选择
            const evEnabled = url.searchParams.get('ev') === 'yes' || (url.searchParams.get('ev') === null && ev);
            const etEnabled = url.searchParams.get('et') === 'yes';
            const vmEnabled = url.searchParams.get('mess') === 'yes';

            // 运营商选择
            const ispMobile = url.searchParams.get('ispMobile') !== 'no';
            const ispUnicom = url.searchParams.get('ispUnicom') !== 'no';
            const ispTelecom = url.searchParams.get('ispTelecom') !== 'no';
            
            // TLS控制（ECH 开启时强制仅 TLS）
            let disableNonTLS = url.searchParams.get('dkby') === 'yes';
            const echParam = url.searchParams.get('ech');
            const echEnabled = echParam === 'yes' || (echParam === null && enableECH);
            if (echEnabled) disableNonTLS = true;
            const customDNSParam = url.searchParams.get('customDNS') || customDNS;
            const customECHDomainParam = url.searchParams.get('customECHDomain') || customECHDomain;
            const echConfig = echEnabled ? `${customECHDomainParam}+${customDNSParam}` : null;

            // 自定义路径
            const customPath = url.searchParams.get('path') || '/';

            return await handleSubscriptionRequest(request, uuid, domain, piu, ipv4Enabled, ipv6Enabled, ispMobile, ispUnicom, ispTelecom, evEnabled, etEnabled, vmEnabled, disableNonTLS, customPath, echConfig, { epd: epdEnabled, epi: epiEnabled, egi: egiEnabled });
        }
        
        return new Response('Not Found', { status: 404 });
    }
};
