import {
  createEmptyCustomImageProviderDraft,
  customImageProviderDraftFromUnknown,
  extractCustomImageProviderJson,
  type CustomImageProviderDraft,
  type CustomImageProviderDraftResult,
} from './customImageProviderConfig';
import type {
  ImageRequestVariantV1,
  JsonTemplateValue,
} from './customImageProviderContract';

export interface CustomImageProviderAssistantMessage {
  role: 'system' | 'user';
  content: string;
}

const MAX_DOCUMENTATION_LENGTH = 60_000;
const DATA_URL_PATTERN = /data:[^;,\s]+(?:;[^,\s]+)*;base64,[A-Za-z0-9+/_=-]+/gi;
const LONG_BASE64_PATTERN = /\b[A-Za-z0-9+/_-]{160,}={0,2}\b/g;
const AUTHORIZATION_PATTERN = /(authorization\s*[:=]\s*(?:bearer|basic)?\s*)[^\s,'"}]+/gi;
const API_KEY_PATTERN = /((?:(?:x[-_ ]?(?:goog[-_ ]?)?)?api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|id[-_ ]?token|bearer[-_ ]?token|client[-_ ]?secret|secret[-_ ]?key|password|passphrase|credential|signature|token))(\s*[:=]\s*)[^\s,'"}&}]+/gi;
const QUOTED_SECRET_VALUE_PATTERN = /((?:["'])(?:authorization|proxy[-_ ]?authorization|cookie|set[-_ ]?cookie|(?:x[-_ ]?(?:goog[-_ ]?)?)?api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|id[-_ ]?token|bearer(?:[-_ ]?token)?|client[-_ ]?secret|secret(?:[-_ ]?key)?|signature|credential|password|passphrase|token)(?:["'])\s*:\s*["'])([^"']*)(["'])/gi;
const CURL_HEADER_SECRET_PATTERN = /(-H\s+['"](?:Authorization|Proxy-Authorization|Cookie|Set-Cookie|X-Api-Key|Api-Key|X-Goog-Api-Key|X-Access-Token)\s*:\s*)[^'"]+(['"])/gi;
const SENSITIVE_QUERY_VALUE_PATTERN = /([?&](?:(?:x[-_]?(?:goog[-_]?)?)?api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|client[-_]?secret|secret|signature|credential|password|token)=)[^&#\s]+/gi;
const STANDALONE_AUTH_SCHEME_PATTERN = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/_=-]{8,}/gi;
const SENSITIVE_CONFIG_KEY_PATTERN = /^(?:authorization|proxy[-_]?authorization|cookie|set[-_]?cookie|(?:x[-_]?(?:goog[-_]?)?)?api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|bearer(?:[-_]?token)?|client[-_]?secret|secret(?:[-_]?key)?|signature|credential|password|passphrase|token)$/i;

function omitSensitiveConfigEntries(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(omitSensitiveConfigEntries);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !SENSITIVE_CONFIG_KEY_PATTERN.test(key.trim()))
      .map(([key, entry]) => [key, omitSensitiveConfigEntries(entry)]),
  );
}

function sanitizeStringRecord(record: Record<string, string> | undefined): Record<string, string> {
  return Object.fromEntries(
    Object.entries(record ?? {}).filter(([key]) => !SENSITIVE_CONFIG_KEY_PATTERN.test(key.trim())),
  );
}

function sanitizeVariant(variant: ImageRequestVariantV1 | undefined): ImageRequestVariantV1 | undefined {
  if (!variant) return undefined;
  const headers = omitSensitiveConfigEntries(variant.headers) as Record<string, JsonTemplateValue> | undefined;
  const query = omitSensitiveConfigEntries(variant.query) as Record<string, JsonTemplateValue> | undefined;
  const bodyTemplate = omitSensitiveConfigEntries(variant.bodyTemplate) as JsonTemplateValue | undefined;
  const asyncTask = omitSensitiveConfigEntries(variant.asyncTask) as Record<string, JsonTemplateValue> | undefined;
  return {
    ...variant,
    ...(headers && Object.keys(headers).length > 0 ? { headers } : { headers: undefined }),
    ...(query && Object.keys(query).length > 0 ? { query } : { query: undefined }),
    ...(bodyTemplate !== undefined ? { bodyTemplate } : {}),
    ...(asyncTask && Object.keys(asyncTask).length > 0 ? { asyncTask } : { asyncTask: undefined }),
  };
}

function sanitizeAssistantDraft(draft: CustomImageProviderDraft): CustomImageProviderDraft {
  const defaultRequestParams = omitSensitiveConfigEntries(draft.defaultRequestParams) as Record<string, unknown>;
  const extraParams = omitSensitiveConfigEntries(draft.extraParams) as Record<string, unknown>;
  const imageRequestContract = {
    ...draft.imageRequestContract,
    ...(draft.imageRequestContract.textToImage
      ? { textToImage: sanitizeVariant(draft.imageRequestContract.textToImage) }
      : {}),
    ...(draft.imageRequestContract.imageToImage
      ? { imageToImage: sanitizeVariant(draft.imageRequestContract.imageToImage) }
      : {}),
  };
  return {
    ...draft,
    apiKey: '',
    extraHeaders: sanitizeStringRecord(draft.extraHeaders),
    queryParams: sanitizeStringRecord(draft.queryParams),
    defaultRequestParams,
    extraParams: {
      ...extraParams,
      defaultRequestParams,
      imageRequestContract,
    },
    imageRequestContract,
  };
}

export const CUSTOM_PROVIDER_ASSISTANT_SCHEMA_INSTRUCTION = `你是图片 API 声明式配置助手。根据用户粘贴的公开文档或 cURL，返回且只返回一个 JSON 对象，不要 markdown、解释、注释或代码块。

安全规则：
- 不要输出 apiKey、Authorization、Cookie、签名、访问令牌或任何真实密钥值。
- 不要输出图片 data URL、base64 样本或二进制内容。
- 仅生成声明式 JSON；禁止 JavaScript、Python、函数、插件代码、动态表达式或原型字段。
- 需要 AK/SK 签名、预上传或厂商 SDK 时，compatibility.needsProxy=true，并说明应使用后端代理。

必须输出以下结构。没有资料的可选字段用空字符串、空数组或空对象，但 imageRequestContract.version 必须为 1：
{
  "templateKey": "openai_images | openai_proxy | openai_chat_image | openai_responses_image | grsai_draw_async | fal | fal_queue_async | replicate_prediction_async | stability | multipart_proxy_required | form_urlencoded | signed_proxy_required | generic_async_poll | generic_json | manual",
  "templateReason": "选择原因",
  "compatibility": {
    "canDirectCall": true,
    "needsProxy": false,
    "risk": "none | async-poll | multipart | form-urlencoded | signed-auth | unknown",
    "reason": "兼容性说明"
  },
  "label": "服务商显示名",
  "baseUrl": "https://api.example.com",
  "endpointPath": "/v1/images/generations",
  "modelListEndpointPath": "/models",
  "httpMethod": "POST",
  "apiStyle": "openai-compatible | fal | replicate | stability | generic-json",
  "models": ["image-model-id"],
  "supportsWebSearch": false,
  "supportedRatios": ["auto", "16:9", "1:1", "9:16"],
  "supportedResolutions": ["1024x1024", "1536x1024", "1024x1536"],
  "supportedModelVersions": [],
  "extraHeaders": {},
  "queryParams": {},
  "responseFormat": "openai-images | url-array | data-url | generic",
  "defaultRequestParams": {},
  "imageRequestContract": {
    "version": 1,
    "textToImage": {
      "endpointPath": "/v1/images/generations",
      "method": "POST",
      "bodyMode": "json | multipart | form-urlencoded",
      "query": {},
      "headers": {},
      "bodyTemplate": {
        "model": "{{model}}",
        "prompt": "{{prompt}}",
        "size": "{{size}}",
        "aspect_ratio": "{{aspectRatio}}"
      },
      "responseImagePaths": ["data[0].url", "data[0].b64_json"],
      "asyncTask": {}
    },
    "imageToImage": {
      "endpointPath": "/v1/images/generations",
      "method": "POST",
      "bodyMode": "multipart",
      "bodyTemplate": {
        "model": "{{model}}",
        "prompt": "{{prompt}}"
      },
      "imageFields": [
        { "name": "image", "mode": "single | array | repeat", "encoding": "data-url | base64 | url" }
      ],
      "responseImagePaths": ["data[0].url", "data[0].b64_json"],
      "asyncTask": {}
    },
    "ratioMappings": {
      "16:9": {
        "ratio": "16:9 或供应商枚举值",
        "size": "3840x2160 或供应商尺寸值",
        "fields": {
          "input.aspectRatio": "{{aspectRatio}}",
          "input.output.size": "{{size}}"
        }
      }
    }
  },
  "note": "注意事项"
}

契约规则：
1. 文生图和图生图 endpoint 必须分别依据文档填写；绝不能因为有参考图就擅自改成 /images/edits。若文档让两者都走 /images/generations，就在两个 variant 中填同一路径。
2. bodyTemplate 只能使用 {{model}}、{{prompt}}、{{size}}、{{aspectRatio}}、{{images}}、{{firstImage}}、{{extra.foo}}。multipart/form-urlencoded 也必须显式保留真实 model 字段，除非文档明确没有 model。
3. 图生图图片字段必须显式给出 imageFields，mode 只能是 single、array、repeat；不要靠字段名猜数组形态。
4. ratioMappings.fields 使用安全点路径或数组路径，可把 16:9 映射到 aspect_ratio、aspectRatio、嵌套字段或 size=3840x2160；不要全局反转宽高。
5. 同步结果把所有可信图片路径写入 responseImagePaths。异步接口必须填写 taskIdPath、resultEndpointPath、resultMethod、imagePath、statusPath、pendingValues、successValues、failedValues、errorPath、intervalMs、timeoutMs。
6. headers 只允许文档明确要求的固定、非敏感值；不要生成 Authorization 或 API key header。`;

export const CUSTOM_PROVIDER_TUTORIAL_PROMPT = `${CUSTOM_PROVIDER_ASSISTANT_SCHEMA_INSTRUCTION}

下面是服务商公开资料，请按上面的 schema 生成配置：
<<此处粘贴文档 / cURL / 请求示例>>`;

export function sanitizeProviderDocumentationForAi(documentation: string): string {
  const source = documentation.slice(0, MAX_DOCUMENTATION_LENGTH);
  return source
    .replace(DATA_URL_PATTERN, '[base64 image omitted]')
    .replace(LONG_BASE64_PATTERN, '[base64 omitted]')
    .replace(CURL_HEADER_SECRET_PATTERN, '$1[redacted]$2')
    .replace(QUOTED_SECRET_VALUE_PATTERN, '$1[redacted]$3')
    .replace(AUTHORIZATION_PATTERN, '$1[redacted]')
    .replace(API_KEY_PATTERN, '$1$2[redacted]')
    .replace(SENSITIVE_QUERY_VALUE_PATTERN, '$1[redacted]')
    .replace(STANDALONE_AUTH_SCHEME_PATTERN, '$1 [redacted]')
    .trim();
}

export function buildCustomImageProviderAssistantMessages(
  documentation: string,
): CustomImageProviderAssistantMessage[] {
  const sanitizedDocumentation = sanitizeProviderDocumentationForAi(documentation);
  if (!sanitizedDocumentation) {
    throw new Error('请先粘贴供应商公开文档或 cURL 示例');
  }
  return [
    { role: 'system', content: CUSTOM_PROVIDER_ASSISTANT_SCHEMA_INSTRUCTION },
    { role: 'user', content: sanitizedDocumentation },
  ];
}

export function parseCustomImageProviderAssistantResponse(
  responseText: string,
  baseDraft: CustomImageProviderDraft = createEmptyCustomImageProviderDraft(),
): CustomImageProviderDraftResult {
  const parsed = extractCustomImageProviderJson(responseText);
  const result = customImageProviderDraftFromUnknown(parsed, baseDraft);
  return result.value
    ? { ...result, value: sanitizeAssistantDraft(result.value) }
    : result;
}
