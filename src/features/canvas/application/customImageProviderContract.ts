export type ImageRequestBodyMode = 'json' | 'multipart' | 'form-urlencoded';
export type ImageRequestMethod = 'GET' | 'POST';
export type ImageFieldMode = 'single' | 'array' | 'repeat';
export type ImageFieldEncoding = 'data-url' | 'base64' | 'url';

// Internal persistence marker used only for lazy legacy migration. It lives
// beside the contract schema rather than inside the user-editable contract so
// hand-authored/AI-generated versioned contracts never accidentally inherit
// old requestBodyHints.
export const CUSTOM_IMAGE_REQUEST_LEGACY_FALLBACK_KEY = 'imageRequestContractLegacyFallback';

export type JsonTemplatePrimitive = string | number | boolean | null;
export type JsonTemplateValue =
  | JsonTemplatePrimitive
  | JsonTemplateValue[]
  | { [key: string]: JsonTemplateValue };

export interface ImageFieldDescriptorV1 {
  name: string;
  mode: ImageFieldMode;
  encoding?: ImageFieldEncoding;
}

export interface ImageRequestVariantV1 {
  endpointPath?: string;
  method?: ImageRequestMethod;
  bodyMode?: ImageRequestBodyMode;
  headers?: Record<string, JsonTemplateValue>;
  query?: Record<string, JsonTemplateValue>;
  bodyTemplate?: JsonTemplateValue;
  imageFields?: ImageFieldDescriptorV1[];
  responseImagePaths?: string[];
  asyncTask?: Record<string, JsonTemplateValue>;
}

export interface ImageRatioMappingV1 {
  ratio?: string;
  size?: string;
  fields?: Record<string, JsonTemplateValue>;
}

export interface CustomImageRequestContractV1 {
  version: 1;
  textToImage?: ImageRequestVariantV1;
  imageToImage?: ImageRequestVariantV1;
  ratioMappings?: Record<string, ImageRatioMappingV1>;
}

export interface ContractValidationIssue {
  path: string;
  message: string;
}

export interface ContractNormalizationResult {
  value: CustomImageRequestContractV1 | null;
  issues: ContractValidationIssue[];
}

export interface ImageRequestTemplateContext {
  model: string;
  prompt: string;
  size: string;
  aspectRatio: string;
  images: string[];
  extra?: Record<string, unknown>;
}

export interface AppliedRatioMapping {
  aspectRatio: string;
  size: string;
  body: Record<string, unknown>;
  mapping: ImageRatioMappingV1 | null;
}

export interface ImageAspectDiagnostic {
  kind: 'aspect-ratio-mismatch';
  requestedRatio: string;
  requestedAspect: number;
  actualWidth: number;
  actualHeight: number;
  actualAspect: number;
  orientation: 'reversed' | 'different';
  relativeDifference: number;
}

type PathPart = string | number;

const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const BODY_MODES = new Set<ImageRequestBodyMode>(['json', 'multipart', 'form-urlencoded']);
const IMAGE_FIELD_MODES = new Set<ImageFieldMode>(['single', 'array', 'repeat']);
const IMAGE_ENCODINGS = new Set<ImageFieldEncoding>(['data-url', 'base64', 'url']);
const TEMPLATE_TOKEN_PATTERN = /\{\{\s*([A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_$-]+)*)\s*\}\}/g;
const WHOLE_TEMPLATE_TOKEN_PATTERN = /^\{\{\s*([A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_$-]+)*)\s*\}\}$/;
const ANY_TEMPLATE_TOKEN_PATTERN = /\{\{\s*([^{}]+?)\s*\}\}/g;
const ALLOWED_TEMPLATE_ROOTS = new Set([
  'model',
  'prompt',
  'size',
  'aspectRatio',
  'images',
  'firstImage',
]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isSafeKey(key: string): boolean {
  return Boolean(key) && !UNSAFE_KEYS.has(key);
}

function issue(issues: ContractValidationIssue[], path: string, message: string): void {
  issues.push({ path, message });
}

function cloneJsonTemplateValue(
  value: unknown,
  path: string,
  issues: ContractValidationIssue[],
): JsonTemplateValue | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return value;
    issue(issues, path, '数字必须是有限值');
    return undefined;
  }
  if (Array.isArray(value)) {
    const result: JsonTemplateValue[] = [];
    value.forEach((entry, index) => {
      const cloned = cloneJsonTemplateValue(entry, `${path}[${index}]`, issues);
      if (cloned !== undefined) result.push(cloned);
    });
    return result;
  }
  if (isPlainRecord(value)) {
    const result: Record<string, JsonTemplateValue> = {};
    Object.entries(value).forEach(([key, entry]) => {
      if (!isSafeKey(key)) {
        issue(issues, `${path}.${key}`, '不允许原型或构造器字段');
        return;
      }
      const cloned = cloneJsonTemplateValue(entry, `${path}.${key}`, issues);
      if (cloned !== undefined) result[key] = cloned;
    });
    return result;
  }
  issue(issues, path, '仅允许 JSON 字符串、数字、布尔值、null、数组和对象');
  return undefined;
}

function normalizeJsonRecord(
  value: unknown,
  path: string,
  issues: ContractValidationIssue[],
): Record<string, JsonTemplateValue> | undefined {
  if (value === undefined) return undefined;
  if (!isPlainRecord(value)) {
    issue(issues, path, '必须是 JSON 对象');
    return undefined;
  }
  const cloned = cloneJsonTemplateValue(value, path, issues);
  return isPlainRecord(cloned) ? cloned as Record<string, JsonTemplateValue> : undefined;
}

export function normalizeResponseImagePaths(
  value: unknown,
  issues: ContractValidationIssue[] = [],
  path = 'responseImagePaths',
): string[] {
  const values = typeof value === 'string' ? [value] : Array.isArray(value) ? value : [];
  const unique = new Set<string>();
  values.forEach((entry) => {
    if (typeof entry !== 'string') return;
    const normalized = entry.trim();
    if (!normalized) return;
    try {
      parseSafeFieldPath(normalized);
      unique.add(normalized);
    } catch (error) {
      issue(issues, `${path}[${unique.size}]`, error instanceof Error ? error.message : '响应图片路径无效');
    }
  });
  return [...unique];
}

function validateTemplateTokens(
  value: JsonTemplateValue | undefined,
  path: string,
  issues: ContractValidationIssue[],
): void {
  if (value === undefined) return;
  if (typeof value === 'string') {
    ANY_TEMPLATE_TOKEN_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = ANY_TEMPLATE_TOKEN_PATTERN.exec(value)) !== null) {
      const token = match[1].trim();
      const isAllowed = ALLOWED_TEMPLATE_ROOTS.has(token)
        || (token.startsWith('extra.') && (() => {
          try {
            parseSafeFieldPath(token.slice('extra.'.length));
            return true;
          } catch {
            return false;
          }
        })());
      if (!isAllowed) {
        issue(issues, path, `不支持的模板变量：${token}`);
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => validateTemplateTokens(entry, `${path}[${index}]`, issues));
    return;
  }
  if (isPlainRecord(value)) {
    Object.entries(value).forEach(([key, entry]) => {
      validateTemplateTokens(entry, `${path}.${key}`, issues);
    });
  }
}

export function normalizeImageFieldDescriptors(
  value: unknown,
  issues: ContractValidationIssue[] = [],
  path = 'imageFields',
): ImageFieldDescriptorV1[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    issue(issues, path, '必须是数组');
    return [];
  }

  const result: ImageFieldDescriptorV1[] = [];
  value.forEach((entry, index) => {
    const entryPath = `${path}[${index}]`;
    if (!isPlainRecord(entry)) {
      issue(issues, entryPath, '图片字段必须是对象');
      return;
    }
    const name = typeof entry.name === 'string' ? entry.name.trim() : '';
    if (!name) {
      issue(issues, `${entryPath}.name`, '图片字段名不能为空');
      return;
    }
    try {
      parseSafeFieldPath(name.endsWith('[]') ? name.slice(0, -2) : name);
    } catch (error) {
      issue(issues, `${entryPath}.name`, error instanceof Error ? error.message : '图片字段路径无效');
      return;
    }
    const mode = typeof entry.mode === 'string' && IMAGE_FIELD_MODES.has(entry.mode as ImageFieldMode)
      ? entry.mode as ImageFieldMode
      : 'single';
    if (entry.mode !== undefined && mode !== entry.mode) {
      issue(issues, `${entryPath}.mode`, '仅支持 single、array 或 repeat');
    }
    const encoding = typeof entry.encoding === 'string' && IMAGE_ENCODINGS.has(entry.encoding as ImageFieldEncoding)
      ? entry.encoding as ImageFieldEncoding
      : undefined;
    if (entry.encoding !== undefined && !encoding) {
      issue(issues, `${entryPath}.encoding`, '仅支持 data-url、base64 或 url');
    }
    result.push({ name, mode, ...(encoding ? { encoding } : {}) });
  });
  return result;
}

function normalizeVariant(
  value: unknown,
  path: string,
  issues: ContractValidationIssue[],
): ImageRequestVariantV1 | undefined {
  if (value === undefined) return undefined;
  if (!isPlainRecord(value)) {
    issue(issues, path, '请求变体必须是对象');
    return undefined;
  }

  const endpointPath = typeof value.endpointPath === 'string' && value.endpointPath.trim()
    ? value.endpointPath.trim()
    : undefined;
  const methodRaw = typeof value.method === 'string' ? value.method.trim().toUpperCase() : '';
  const method = methodRaw === 'GET' || methodRaw === 'POST' ? methodRaw : undefined;
  if (value.method !== undefined && !method) {
    issue(issues, `${path}.method`, '仅支持 GET 或 POST');
  }
  const bodyMode = typeof value.bodyMode === 'string' && BODY_MODES.has(value.bodyMode as ImageRequestBodyMode)
    ? value.bodyMode as ImageRequestBodyMode
    : undefined;
  if (value.bodyMode !== undefined && !bodyMode) {
    issue(issues, `${path}.bodyMode`, '仅支持 json、multipart 或 form-urlencoded');
  }
  const bodyTemplate = value.bodyTemplate === undefined
    ? undefined
    : cloneJsonTemplateValue(value.bodyTemplate, `${path}.bodyTemplate`, issues);
  const imageFields = normalizeImageFieldDescriptors(value.imageFields, issues, `${path}.imageFields`);
  const responseImagePaths = normalizeResponseImagePaths(
    value.responseImagePaths ?? value.responseImagePath,
    issues,
    `${path}.responseImagePaths`,
  );
  const headers = normalizeJsonRecord(value.headers, `${path}.headers`, issues);
  const query = normalizeJsonRecord(value.query, `${path}.query`, issues);
  const asyncTask = normalizeJsonRecord(value.asyncTask ?? value.async, `${path}.asyncTask`, issues);

  validateTemplateTokens(bodyTemplate, `${path}.bodyTemplate`, issues);
  validateTemplateTokens(headers, `${path}.headers`, issues);
  validateTemplateTokens(query, `${path}.query`, issues);
  validateTemplateTokens(asyncTask, `${path}.asyncTask`, issues);

  return {
    ...(endpointPath ? { endpointPath } : {}),
    ...(method ? { method } : {}),
    ...(bodyMode ? { bodyMode } : {}),
    ...(headers ? { headers } : {}),
    ...(query ? { query } : {}),
    ...(bodyTemplate !== undefined ? { bodyTemplate } : {}),
    ...(imageFields.length > 0 ? { imageFields } : {}),
    ...(responseImagePaths.length > 0 ? { responseImagePaths } : {}),
    ...(asyncTask ? { asyncTask } : {}),
  };
}

function normalizeRatioMappings(
  value: unknown,
  issues: ContractValidationIssue[],
): Record<string, ImageRatioMappingV1> | undefined {
  if (value === undefined) return undefined;
  if (!isPlainRecord(value)) {
    issue(issues, 'ratioMappings', '必须是对象');
    return undefined;
  }
  const result: Record<string, ImageRatioMappingV1> = {};
  Object.entries(value).forEach(([ratioKey, rawMapping]) => {
    const path = `ratioMappings.${ratioKey}`;
    if (!isSafeKey(ratioKey)) {
      issue(issues, path, '比例键不安全');
      return;
    }
    if (!isPlainRecord(rawMapping)) {
      issue(issues, path, '比例映射必须是对象');
      return;
    }
    const ratio = typeof rawMapping.ratio === 'string' && rawMapping.ratio.trim()
      ? rawMapping.ratio.trim()
      : undefined;
    const size = typeof rawMapping.size === 'string' && rawMapping.size.trim()
      ? rawMapping.size.trim()
      : undefined;
    const fields = normalizeJsonRecord(rawMapping.fields, `${path}.fields`, issues);
    validateTemplateTokens(fields, `${path}.fields`, issues);
    result[ratioKey.trim()] = {
      ...(ratio ? { ratio } : {}),
      ...(size ? { size } : {}),
      ...(fields ? { fields } : {}),
    };
  });
  return Object.keys(result).length > 0 ? result : undefined;
}

export function normalizeCustomImageRequestContract(input: unknown): ContractNormalizationResult {
  const issues: ContractValidationIssue[] = [];
  if (!isPlainRecord(input)) {
    return {
      value: null,
      issues: [{ path: 'imageRequestContract', message: '配置必须是 JSON 对象' }],
    };
  }
  if (input.version !== 1) {
    return {
      value: null,
      issues: [{ path: 'imageRequestContract.version', message: '仅支持版本 1' }],
    };
  }

  const textToImage = normalizeVariant(input.textToImage, 'textToImage', issues);
  const imageToImage = normalizeVariant(input.imageToImage, 'imageToImage', issues);
  const ratioMappings = normalizeRatioMappings(input.ratioMappings, issues);
  return {
    value: {
      version: 1,
      ...(textToImage ? { textToImage } : {}),
      ...(imageToImage ? { imageToImage } : {}),
      ...(ratioMappings ? { ratioMappings } : {}),
    },
    issues,
  };
}

export function selectImageRequestVariant(
  contract: CustomImageRequestContractV1,
  hasReferenceImages: boolean,
): ImageRequestVariantV1 | null {
  return hasReferenceImages
    ? contract.imageToImage ?? contract.textToImage ?? null
    : contract.textToImage ?? contract.imageToImage ?? null;
}

export function parseSafeFieldPath(rawPath: string): PathPart[] {
  const source = rawPath.trim();
  if (!source) throw new Error('字段路径不能为空');
  const parts: PathPart[] = [];
  let index = 0;

  const pushKey = (key: string): void => {
    if (!isSafeKey(key)) throw new Error(`字段路径包含不安全片段：${key}`);
    parts.push(key);
  };

  while (index < source.length) {
    if (source[index] === '.') {
      index += 1;
      if (index >= source.length) throw new Error('字段路径不能以点结尾');
    }

    if (source[index] === '[') {
      const closeIndex = source.indexOf(']', index + 1);
      if (closeIndex < 0) throw new Error('字段路径缺少右括号');
      const rawPart = source.slice(index + 1, closeIndex).trim();
      if (/^\d+$/.test(rawPart)) {
        parts.push(Number(rawPart));
      } else {
        const quoted = /^(?:"([^"]+)"|'([^']+)')$/.exec(rawPart);
        if (!quoted) throw new Error(`字段路径括号片段无效：${rawPart}`);
        pushKey(quoted[1] ?? quoted[2]);
      }
      index = closeIndex + 1;
      continue;
    }

    const match = /^[A-Za-z0-9_$-]+/.exec(source.slice(index));
    if (!match) throw new Error(`字段路径在 ${source.slice(index)} 附近无效`);
    pushKey(match[0]);
    index += match[0].length;
    if (index < source.length && source[index] !== '.' && source[index] !== '[') {
      throw new Error(`字段路径在 ${source.slice(index)} 附近无效`);
    }
  }

  if (typeof parts[0] !== 'string') throw new Error('字段路径必须从对象字段开始');
  return parts;
}

export function setValueAtSafePath(
  target: Record<string, unknown>,
  rawPath: string,
  value: unknown,
): void {
  const parts = parseSafeFieldPath(rawPath);
  let current: Record<string, unknown> | unknown[] = target;

  parts.forEach((part, index) => {
    const isLast = index === parts.length - 1;
    const nextPart = parts[index + 1];
    if (typeof part === 'number') {
      if (!Array.isArray(current)) throw new Error(`字段路径 ${rawPath} 的数组层级无效`);
      if (isLast) {
        current[part] = value;
        return;
      }
      const existing = current[part];
      const needsArray = typeof nextPart === 'number';
      if (!existing || typeof existing !== 'object' || (needsArray && !Array.isArray(existing))) {
        current[part] = needsArray ? [] : {};
      }
      current = current[part] as Record<string, unknown> | unknown[];
      return;
    }

    if (Array.isArray(current)) throw new Error(`字段路径 ${rawPath} 缺少数组索引`);
    if (isLast) {
      current[part] = value;
      return;
    }
    const existing = current[part];
    const needsArray = typeof nextPart === 'number';
    if (!existing || typeof existing !== 'object' || (needsArray && !Array.isArray(existing))) {
      current[part] = needsArray ? [] : {};
    }
    current = current[part] as Record<string, unknown> | unknown[];
  });
}

function getValueAtSafePath(value: unknown, rawPath: string): unknown {
  const parts = parseSafeFieldPath(rawPath);
  let current = value;
  for (const part of parts) {
    if (typeof part === 'number') {
      if (!Array.isArray(current)) return undefined;
      current = current[part];
    } else {
      if (!isPlainRecord(current)) return undefined;
      current = current[part];
    }
  }
  return current;
}

function templateTokenValue(token: string, context: ImageRequestTemplateContext): unknown {
  switch (token) {
    case 'model': return context.model;
    case 'prompt': return context.prompt;
    case 'size': return context.size;
    case 'aspectRatio': return context.aspectRatio;
    case 'images': return [...context.images];
    case 'firstImage': return context.images[0] ?? null;
    default:
      if (token.startsWith('extra.')) {
        return getValueAtSafePath(context.extra ?? {}, token.slice('extra.'.length));
      }
      throw new Error(`不支持的模板变量：${token}`);
  }
}

function cloneTemplateResult(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneTemplateResult);
  if (isPlainRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, cloneTemplateResult(entry)]));
  }
  return value;
}

export function interpolateImageRequestTemplate(
  template: JsonTemplateValue,
  context: ImageRequestTemplateContext,
): unknown {
  if (typeof template === 'string') {
    const wholeToken = WHOLE_TEMPLATE_TOKEN_PATTERN.exec(template);
    if (wholeToken) {
      return cloneTemplateResult(templateTokenValue(wholeToken[1], context) ?? null);
    }
    TEMPLATE_TOKEN_PATTERN.lastIndex = 0;
    return template.replace(TEMPLATE_TOKEN_PATTERN, (_match, token: string) => {
      const value = templateTokenValue(token, context);
      if (value === undefined || value === null) return '';
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        return String(value);
      }
      return JSON.stringify(value);
    });
  }
  if (Array.isArray(template)) {
    return template.map((entry) => interpolateImageRequestTemplate(entry, context));
  }
  if (template && typeof template === 'object') {
    const result: Record<string, unknown> = {};
    Object.entries(template).forEach(([key, value]) => {
      if (!isSafeKey(key)) throw new Error(`模板包含不安全字段：${key}`);
      result[key] = interpolateImageRequestTemplate(value, context);
    });
    return result;
  }
  return template;
}

export function applyCustomImageRatioMapping(
  contract: CustomImageRequestContractV1,
  requestedRatio: string,
  context: ImageRequestTemplateContext,
  initialBody: Record<string, unknown> = {},
): AppliedRatioMapping {
  const mapping = contract.ratioMappings?.[requestedRatio]
    ?? contract.ratioMappings?.default
    ?? null;
  const aspectRatio = mapping?.ratio ?? context.aspectRatio;
  const size = mapping?.size ?? context.size;
  const body = cloneTemplateResult(initialBody) as Record<string, unknown>;
  if (mapping?.fields) {
    const mappedContext: ImageRequestTemplateContext = { ...context, aspectRatio, size };
    Object.entries(mapping.fields).forEach(([path, template]) => {
      setValueAtSafePath(body, path, interpolateImageRequestTemplate(template, mappedContext));
    });
  }
  return { aspectRatio, size, body, mapping };
}

function parseRequestedAspect(value: string): number | null {
  const ratioMatch = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(value.trim());
  if (ratioMatch) {
    const width = Number(ratioMatch[1]);
    const height = Number(ratioMatch[2]);
    return width > 0 && height > 0 ? width / height : null;
  }
  const sizeMatch = /^(\d+)x(\d+)$/i.exec(value.trim());
  if (sizeMatch) {
    const width = Number(sizeMatch[1]);
    const height = Number(sizeMatch[2]);
    return width > 0 && height > 0 ? width / height : null;
  }
  return null;
}

export function diagnoseImageAspectMismatch(input: {
  requestedRatio: string;
  actualWidth: number;
  actualHeight: number;
  tolerance?: number;
}): ImageAspectDiagnostic | null {
  const requestedAspect = parseRequestedAspect(input.requestedRatio);
  if (!requestedAspect || !Number.isFinite(input.actualWidth) || !Number.isFinite(input.actualHeight)) return null;
  if (input.actualWidth <= 0 || input.actualHeight <= 0) return null;
  const actualAspect = input.actualWidth / input.actualHeight;
  const relativeDifference = Math.abs(Math.log(actualAspect / requestedAspect));
  const tolerance = Math.max(0.01, input.tolerance ?? 0.12);
  if (relativeDifference <= tolerance) return null;
  const reversedDifference = Math.abs(Math.log(actualAspect / (1 / requestedAspect)));
  return {
    kind: 'aspect-ratio-mismatch',
    requestedRatio: input.requestedRatio,
    requestedAspect,
    actualWidth: input.actualWidth,
    actualHeight: input.actualHeight,
    actualAspect,
    orientation: reversedDifference <= tolerance ? 'reversed' : 'different',
    relativeDifference,
  };
}
