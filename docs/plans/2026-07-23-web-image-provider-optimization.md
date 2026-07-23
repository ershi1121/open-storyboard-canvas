# Web 部署与图片模型配置优化 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 让 Storyboard-Copilot 在普通浏览器中稳定启动并具备基础本地项目能力，同时将图片模型配置升级为安全、可组合、可由 AI 生成草稿的声明式 HTTP 契约。

**Architecture:** 在 Tauri/浏览器边界增加运行时能力适配，在 canvas application 层统一归一化图片请求模板、比例映射和响应诊断，在 custom provider gateway 层编译为现有 HTTP DTO。设置 UI 与 AI 助手只编辑经过同一 schema 校验的配置，旧 extraParams 保留为兼容回退。

**Tech Stack:** React 18, TypeScript, Zustand, Vite, Tauri 2, Vitest, Playwright, localStorage。

---

### Task 1: Add browser runtime guards

**Files:**
- Modify: `src/components/TitleBar.tsx`
- Modify: `src/App.tsx`
- Test: `src/components/TitleBar.test.tsx` (or the repository's existing component test location)

**Step 1: Write the failing test**

Render `TitleBar` with `isTauri()` false and assert it does not call `getCurrentWindow`, does not render desktop window controls, and still renders settings/language/theme controls.

**Step 2: Run test to verify it fails**

Run: `npm test -- --run src/components/TitleBar.test.tsx`
Expected: FAIL with the current `getCurrentWindow` metadata error or a missing test module.

**Step 3: Write minimal implementation**

Guard `getCurrentWindow()` and all window callbacks behind `isTauri()`. Guard the `frontend_ready` effect in `App.tsx` so the browser never starts a retry timer.

**Step 4: Run test to verify it passes**

Run: `npm test -- --run src/components/TitleBar.test.tsx`
Expected: PASS.

### Task 2: Add browser project persistence fallback

**Files:**
- Modify: `src/commands/projectState.ts`
- Create: `src/commands/webProjectState.ts`
- Modify: `src/stores/projectStore.ts`
- Test: `src/commands/webProjectState.test.ts`

Implement a versioned localStorage record with memory fallback, use it only when `isTauri()` is false, and keep Tauri calls untouched. Test CRUD and malformed-storage recovery.

### Task 3: Implement the declarative image contract

**Files:**
- Create: `src/features/canvas/application/customImageProviderContract.ts`
- Modify: `src/features/canvas/infrastructure/customProviderGateway.ts`
- Test: `src/features/canvas/application/customImageProviderContract.test.ts`
- Test: `src/features/canvas/infrastructure/customProviderGateway.test.ts`

Implement safe JSON template interpolation, nested path writes, ratio mappings, image field cardinality, request variants, response paths, and bounded async polling. Reject executable values and preserve legacy fallback behavior.

### Task 4: Add actual result aspect diagnostics

**Files:**
- Modify: `src/features/canvas/application/imageData.ts`
- Modify: `src/features/canvas/infrastructure/customProviderGateway.ts`
- Test: `src/features/canvas/application/imageRequestGeometry.test.ts`

Read result dimensions at the materialization boundary, compare with the requested ratio using a tolerance, and return a non-fatal diagnostic without reversing or retrying the request.

### Task 5: Migrate configuration and rename settings surfaces

**Files:**
- Modify: `src/stores/customProvidersStore.ts`
- Create: `src/features/canvas/application/customImageProviderConfig.ts`
- Modify: `src/components/settings/AddProvidersSection.tsx`
- Modify: `src/components/settings/SettingsDialog.tsx`
- Modify: `src/components/settings/ModernProvidersSection.tsx`
- Modify: `src/components/settings/CustomProvidersSection.tsx`
- Modify: `src/i18n/locales/zh.json`
- Modify: `src/i18n/locales/en.json`
- Test: `src/features/canvas/application/customImageProviderConfig.test.ts`

Add versioned schema normalization and old-field mirrors. Update labels without changing IDs. Make form controls and advanced JSON editor share one serializer/validator.

### Task 6: Add the AI configuration assistant

**Files:**
- Create: `src/features/canvas/application/customImageProviderAiPrompt.ts`
- Create: `src/components/settings/CustomProviderConfigAssistantDialog.tsx`
- Modify: `src/components/settings/CustomProvidersSection.tsx`
- Modify: both locale files
- Test: `src/features/canvas/application/customImageProviderAiPrompt.test.ts`

Reuse the existing chat gateway, redact secrets, parse JSON responses, validate the schema, and feed a draft into the same editor. Preserve copy-prompt/paste-JSON fallback.

### Task 7: Verify and commit

Run:

```bash
npm test
npx tsc --noEmit
npm run build
git diff --check
```

Then perform the browser smoke flow and Tauri smoke flow, stage only intended source/docs files (never the two pre-existing deleted GIFs), and commit with a focused message.
