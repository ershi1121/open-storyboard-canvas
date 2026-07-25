import { redactSensitiveUrl } from '@/features/canvas/application/imageProviderContracts';
import { isTauri } from '@tauri-apps/api/core';

export interface GenerationDebugContext {
  sourceType: 'imageEdit' | 'storyboardGen' | 'aiVideo' | 'aiText' | 'unknown';
  providerId?: string;
  requestModel?: string;
  requestSize?: string;
  requestAspectRatio?: string;
  prompt?: string;
  extraParams?: Record<string, unknown>;
  referenceImageCount?: number;
  referenceImagePlaceholders?: string[];
  appVersion?: string;
  osName?: string;
  osVersion?: string;
  osBuild?: string;
  userAgent?: string;
}

export const CURRENT_RUNTIME_SESSION_ID = `runtime-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
let runtimeDiagnosticsPromise: Promise<Pick<
  GenerationDebugContext,
  'appVersion' | 'osName' | 'osVersion' | 'osBuild' | 'userAgent'
>> | null = null;

interface BuildGenerationErrorReportInput {
  errorMessage: string;
  errorDetails?: string;
  context?: unknown;
}

function toStringSafe(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function isSensitiveDiagnosticFieldName(name: string): boolean {
  return /(?:authorization|proxy[-_ ]?authorization|cookie|set[-_ ]?cookie|(?:x[-_ ]?)?api[-_ ]?key|x[-_ ]?goog[-_ ]?api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|client[-_ ]?secret|secret|signature|credential|password|bearer|(?:^|[-_ ])token(?:$|[-_ ]))/i.test(name);
}

/**
 * Provider failures and saved request context can contain credentials,
 * signed URLs, or inline media. Keep diagnostics readable without copying
 * those values into dialogs, reports, persisted node errors, or logs.
 */
export function sanitizeGenerationDiagnosticText(value: string): string {
  return value
    .replace(/data:[^;\s,]+(?:;[^,\s]+)*;base64,[A-Za-z0-9+/_=-]+/gi, '[data-url omitted]')
    .replace(/\b[A-Za-z0-9+/_-]{160,}={0,2}\b/g, '[base64 omitted]')
    .replace(/\b(Bearer|Basic|Token)\s+[^\s,;"'}]+/gi, '$1 [redacted]')
    .replace(
      /((?:["']?(?:authorization|proxy-authorization|cookie|set-cookie|(?:x-)?api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|client[-_ ]?secret|secret(?:[-_ ]?key)?|signature|credential|password)["']?\s*[:=]\s*["']?))([^\s,"'}]+)(["']?)/gi,
      '$1[redacted]$3',
    )
    .replace(/https?:\/\/[^\s"'<>]+/gi, (url) => redactSensitiveUrl(url));
}

function sanitizeGenerationDiagnosticValue(
  value: unknown,
  key = '',
  depth = 0,
  ancestors = new WeakSet<object>(),
): unknown {
  if (isSensitiveDiagnosticFieldName(key)) return '[redacted]';
  if (value === undefined || value === null) return value;
  if (typeof value === 'string') return sanitizeGenerationDiagnosticText(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value !== 'object') return sanitizeGenerationDiagnosticText(String(value));
  if (depth >= 8) return Array.isArray(value) ? `[array ${value.length}]` : '[object]';
  if (ancestors.has(value)) return '[circular]';

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item, index) =>
        sanitizeGenerationDiagnosticValue(item, `${key}[${index}]`, depth + 1, ancestors));
    }
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([entryKey]) => !['__proto__', 'prototype', 'constructor'].includes(entryKey))
        .map(([entryKey, entryValue]) => [
          entryKey,
          sanitizeGenerationDiagnosticValue(entryValue, entryKey, depth + 1, ancestors),
        ]),
    );
  } finally {
    ancestors.delete(value);
  }
}

export function createReferenceImagePlaceholders(count: number): string[] {
  const safeCount = Math.max(0, Math.min(64, Math.floor(count)));
  return Array.from({ length: safeCount }, (_, index) => `[IMAGE_${index + 1}]`);
}

function parseOsInfo(userAgent: string): { osName: string; osVersion: string } {
  const ua = userAgent || '';

  const windowsMatch = ua.match(/Windows NT ([0-9.]+)/i);
  if (windowsMatch) {
    const ntVersion = windowsMatch[1];
    if (ntVersion.startsWith('10.0')) {
      return { osName: 'Windows', osVersion: '10/11 (NT 10.0)' };
    }
    return { osName: 'Windows', osVersion: `NT ${ntVersion}` };
  }

  const macMatch = ua.match(/Mac OS X ([0-9_]+)/i);
  if (macMatch) {
    return { osName: 'macOS', osVersion: macMatch[1].replace(/_/g, '.') };
  }

  const linuxLike = /Linux|X11/i.test(ua);
  if (linuxLike) {
    return { osName: 'Linux', osVersion: 'unknown' };
  }

  return { osName: 'Unknown', osVersion: 'unknown' };
}

export async function getRuntimeDiagnostics(): Promise<
  Pick<GenerationDebugContext, 'appVersion' | 'osName' | 'osVersion' | 'osBuild' | 'userAgent'>
> {
  if (!runtimeDiagnosticsPromise) {
    runtimeDiagnosticsPromise = (async () => {
      const userAgent = typeof navigator !== 'undefined' ? navigator.userAgent || '' : '';
      const osInfo = parseOsInfo(userAgent);

      let appVersion = 'unknown';
      let resolvedOsName = osInfo.osName;
      let resolvedOsVersion = osInfo.osVersion;
      let resolvedOsBuild = 'unknown';
      if (isTauri()) {
        try {
          const { getVersion } = await import('@tauri-apps/api/app');
          appVersion = await getVersion();
        } catch {
          appVersion = 'unknown';
        }

        try {
          const { getRuntimeSystemInfo } = await import('@/commands/system');
          const systemInfo = await getRuntimeSystemInfo();
          if (systemInfo) {
            if (systemInfo.osName) {
              resolvedOsName = systemInfo.osName;
            }
            if (systemInfo.osVersion) {
              resolvedOsVersion = systemInfo.osVersion;
            }
            if (systemInfo.osBuild) {
              resolvedOsBuild = systemInfo.osBuild;
            }
          }
        } catch {
          // Fallback to user-agent parsed info.
        }
      }

      return {
        appVersion,
        osName: resolvedOsName,
        osVersion: resolvedOsVersion,
        osBuild: resolvedOsBuild,
        userAgent,
      };
    })();
  }

  return runtimeDiagnosticsPromise;
}

export function buildGenerationErrorReport(
  input: BuildGenerationErrorReportInput
): string {
  const context = (input.context ?? {}) as Partial<GenerationDebugContext>;
  const sections: string[] = [];
  sections.push('# Generation Error Report');
  sections.push('');
  sections.push(`- Error: ${sanitizeGenerationDiagnosticText(input.errorMessage || 'unknown error')}`);
  if (input.errorDetails) {
    sections.push(`- Details: ${sanitizeGenerationDiagnosticText(input.errorDetails)}`);
  }
  sections.push(`- App Version: ${sanitizeGenerationDiagnosticText(toStringSafe(context.appVersion ?? 'unknown'))}`);
  sections.push(`- OS: ${sanitizeGenerationDiagnosticText(`${context.osName ?? 'Unknown'} ${context.osVersion ?? 'unknown'}`.trim())}`);
  sections.push(`- OS Build: ${sanitizeGenerationDiagnosticText(toStringSafe(context.osBuild ?? 'unknown'))}`);
  sections.push('');
  sections.push('## Request Context');
  sections.push(`- Source: ${sanitizeGenerationDiagnosticText(toStringSafe(context.sourceType ?? 'unknown'))}`);
  if (context.providerId) {
    sections.push(`- Provider: ${sanitizeGenerationDiagnosticText(context.providerId)}`);
  }
  if (context.requestModel) {
    sections.push(`- Model: ${sanitizeGenerationDiagnosticText(context.requestModel)}`);
  }
  if (context.requestSize) {
    sections.push(`- Size: ${sanitizeGenerationDiagnosticText(context.requestSize)}`);
  }
  if (context.requestAspectRatio) {
    sections.push(`- Aspect Ratio: ${sanitizeGenerationDiagnosticText(context.requestAspectRatio)}`);
  }
  sections.push(`- Reference Images: ${context.referenceImageCount ?? 0}`);
  if (Array.isArray(context.referenceImagePlaceholders) && context.referenceImagePlaceholders.length > 0) {
    sections.push(`- Reference Image Placeholders: ${context.referenceImagePlaceholders.join(', ')}`);
  }
  sections.push('');
  sections.push('## Prompt');
  sections.push(
    context.prompt && context.prompt.trim()
      ? sanitizeGenerationDiagnosticText(context.prompt)
      : '(empty)',
  );
  sections.push('');
  sections.push('## Extra Params');
  const sanitizedExtraParams = sanitizeGenerationDiagnosticValue(context.extraParams);
  sections.push(
    sanitizedExtraParams
      && typeof sanitizedExtraParams === 'object'
      && Object.keys(sanitizedExtraParams).length > 0
      ? toStringSafe(sanitizedExtraParams)
      : '{}'
  );
  if (context.userAgent) {
    sections.push('');
    sections.push('## User Agent');
    sections.push(sanitizeGenerationDiagnosticText(context.userAgent));
  }

  return sections.join('\n');
}
