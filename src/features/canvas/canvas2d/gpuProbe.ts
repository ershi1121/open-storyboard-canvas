/**
 * 光栅化后端探针：经 WEBGL_debug_renderer_info 报告 WebView 实际渲染后端。
 * GPU 型号 = 硬件光栅化；SwiftShader / llvmpipe / Basic Render / Software
 * 等字样 = 软件光栅化（虚拟机/远程桌面/驱动黑名单常见），此时任何引擎
 * （Web 或原生）都会慢，属环境级问题。
 */
let cached: string | null = null;

export function probeRasterBackend(): string {
  if (cached) return cached;
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    if (!gl) {
      cached = 'webgl-unavailable';
      return cached;
    }
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    cached = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : 'unknown';
  } catch {
    cached = 'probe-error';
  }
  return cached;
}

export function isSoftwareRaster(backend: string): boolean {
  return /swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic/i.test(backend);
}
