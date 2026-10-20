# 调试步骤 — 浏览器端 100% 验证

## 1. 确认 toggle 真的渲染了

打开浏览器 DevTools Console，运行：

```js
document.querySelectorAll('[data-testid^="llm-provider-"]').length
```

应该返回 `2`（两个 toggle 按钮：api + local）。

## 2. 确认 toggle 点击有效

DevTools Console：

```js
// 点击 "本地启发式"
document.querySelector('[data-testid="llm-provider-local"]').click()
// 再点击 "保存设置"（Settings 页面底部的"保存设置"按钮，不是 toggle 按钮）
document.querySelector('button[type="submit"]').click()
```

## 3. DevTools Network 面板

按 Save 后立刻看 Network 面板，应该出现：
- `PUT /api/settings/ai` (200 OK)
- Request Payload 包含 `"llmProvider":"local"`
- Response 包含 `"llmProvider":"local"`

## 4. 如果 Network 还是看不到 PUT

说明 React 端**没有触发 save handler**。原因可能：
- Settings 页面有 JS 错误 — 看 Console 红字
- 表单的 onSubmit 没绑上（虽然源码确认绑了）
- "保存设置"按钮在 form 外面（不会触发 submit）

## 5. 如果 Network 看到 PUT 但 body 里没有 llmProvider

说明我之前漏改了。需要在 `lib/api.ts:updateAiSettings` 加 `llmProvider?: "api" | "local"`。