# SAG Reader Script Specification (v1)

## 目的

SAG `SAG.exe` 只认识纯文本。它把"读文件 → 解析为文本"的工作完全交给外部脚本（reader）。这样：

- 不同环境的合规/加密/DLP 工具链（SafeNetLOCK、奇安信、深信服、WPS、Office COM、PDF OCR）只需要替换对应的 reader 脚本，**不需要重新打包 exe**
- 一台电脑装多个 reader 变体（如 `sag-read-docx.ps1` + `sag-read-docx-corp-encrypted.ps1`），exe 按文件名优先级匹配
- Reader 是独立进程，崩溃不会拖死主程序；崩溃一次后 exe 会自动跳过该脚本

## 1. 文件位置

exe 启动时按以下顺序查找 reader：

1. 环境变量 `SAG_READERS_DIR` 指向的目录（开发者测试用）
2. `<exe-dir>/sag-readers/`（生产部署位置；`SAG.exe` 在 `resources/` 下，所以 reader 在 `resources/sag-readers/`）
3. 内嵌 fallback（TS 内置的 PDF.js / mammoth / openpyxl，仅在外部 reader 全部缺席时启用）

每个 reader 脚本名遵循：

```
sag-read-<ext>[.<variant>].<language-ext>
```

例：
- `sag-read-pdf.py` — 默认 PDF reader
- `sag-read-pdf-encrypted.ps1` — 加密 PDF 专用 reader（COM 解密）
- `sag-read-docx-corp.ps1` — 某公司定制的 DOCX reader
- `sag-read-txt.cmd` — Windows 批处理实现

`<ext>` 不含点号，全部小写。

## 2. 调用协议

### 2.1 主调用（提取文本）

```
<reader-script> <input-path>
```

- **argv[1]**：待读取文件的绝对路径
- **stdout**：UTF-8 文本（推荐 markdown 格式；正文+换行）
- **stderr**：可选的元数据（详见 §4）
- **退出码**：
  - `0` — 成功，文本在 stdout
  - `2` — 不支持（文件是该 reader 不认识的子类型），exe 应跳过本 reader
  - `3` — 暂时性错误（依赖服务没起来、网络抖动），exe 会重试
  - 其它非 0 — 永久错误，exe 标记文件失败并不再重试

### 2.2 自检模式

```
<reader-script> --probe <input-path>
```

- 给定文件路径，退出 `0` 表示"我能处理这个文件"，`1` 表示"不能"
- exe 在 dispatch 时先用 `--probe` 探测，第一个返回 0 的 reader 被选中
- `--probe` 应当是**只读**的，绝不能修改原文件或产生副作用

### 2.3 元数据模式

```
<reader-script> --meta
```

- 在 stdout 输出一行 JSON，描述这个 reader 的能力（详见 §4 schema）
- exe 用这个来生成设置面板里的"reader 状态"卡片
- 必须总是返回 exit code `0`

## 3. stdout 文本格式建议

- **纯 UTF-8 文本**，禁用 BOM
- 行尾用 `\n`（不要 `\r\n`）
- 推荐 markdown 结构：
  - 第一行：`# <文档标题>`（如果能拿到）
  - 第二行：`> 作者: ...   创建时间: ...   来源: <basename>`（如果能拿到）
  - 段落用空行分隔
  - 多页文档用 `## 第 N 页` 或 `## Slide N` 之类分隔
- 不要在 stdout 输出进度信息（用 stderr）
- 不要在 stdout 输出 JSON 元数据

## 4. stderr 元数据 schema

可选。exe 不解析 stderr 内容（除了错误回显），但 UI 会展示。

```json
{
  "title": "2024年度审计报告",
  "author": "张三",
  "pages": 24,
  "warnings": ["encrypted-layer-stripped", "embedded-fonts-ignored"],
  "extractedAt": "2026-09-13T14:30:00+08:00",
  "bytes": 582310
}
```

字段都是可选的。

## 5. Manifest（可选）

如果 `sag-readers/` 根下有 `manifest.json`，exe 优先读它来决定 reader 顺序和能力声明：

```json
{
  "version": 1,
  "readers": [
    {
      "script": "sag-read-pdf-encrypted.ps1",
      "extensions": [".pdf"],
      "priority": 100,
      "appliesWhen": { "filenameMatches": ["*-机密*.pdf", "*-secret*.pdf"] },
      "timeoutMs": 300000,
      "languages": ["zh", "en"]
    },
    {
      "script": "sag-read-pdf.py",
      "extensions": [".pdf"],
      "priority": 50,
      "timeoutMs": 120000,
      "languages": ["zh", "en"]
    }
  ]
}
```

`priority` 越高越先尝试；同优先级按文件名排序。`appliesWhen` 是可选的匹配规则（glob）。

如果 manifest 不存在，exe 走默认顺序（按字典序扫所有 `sag-read-<ext>.*`，第一个 `--probe` 返回 0 的胜出）。

## 6. 超时与资源限制

- exe 给每个 reader 进程默认 5 分钟超时
- manifest 里可以覆盖（`timeoutMs`）
- 超时后 exe 杀掉进程，标记文件 `reader-timeout`
- reader 应当自行做内存保护（流式读取大文件）

## 7. 失败分类速查

| 情况 | 退出码 | stderr 提示 | exe 后续动作 |
|------|--------|-------------|-------------|
| 成功 | 0 | 元数据（可选） | 解析 stdout，送给 chunker |
| 加密文件 | 2 | `{"hint":"encrypted"}` | 试下一个 reader；都失败则标记 skipped-encrypted |
| 临时错误（Office 没启动） | 3 | `{"hint":"com-not-running"}` | 重试 3 次，每次间隔 30s |
| 格式损坏 | 1 | 自由文本 | 标记 failed-corrupt，不再重试 |
| 不支持的子类型 | 2 | `{"hint":"unsupported-variant"}` | 试下一个 reader |

## 8. 部署 / 调试

### 8.1 本地测试

在写好 reader 之后，可以手动跑：

```bash
# 默认调用
python sag-readers/sag-read-pdf.py "D:/audit/机密报告.pdf"

# 自检
python sag-readers/sag-read-pdf.py --probe "D:/audit/机密报告.pdf"

# 元数据
python sag-readers/sag-read-pdf.py --meta
```

预期：成功调用应该把所有文本打到 stdout，错误信息到 stderr。

### 8.2 写一个 reader 的清单

1. 实现 `--meta`，声明 extensions/languages/timeoutMs
2. 实现 `--probe <file>`，对支持的文件返回 0，对不支持的返回 1
3. 实现主调用：读文件 → 解析 → 输出 markdown 文本到 stdout
4. 处理加密/损坏/超时，遵循 §7 的退出码
5. 写到 stderr 一个 JSON 元数据（哪怕只是 `{}`）
6. 在 Windows / Mac / Linux 都试一遍
7. 用 100MB+ 的真实文件压一下，确认不爆内存
8. 把依赖列在 `sag-readers/requirements.txt`

### 8.3 验证 reader 是否被 exe 选中

打开 SAG 桌面版 → 设置 → AI 端点 → "Reader 状态"标签（如果有）会显示当前每个 ext 的选中 reader。或者看 `sag-*.log`：

```
grep "reader dispatch" sag-*.log
# 示例输出：
# [reader] .pdf → sag-readers/sag-read-pdf-encrypted.ps1 (priority=100, probe=ok, took=2431ms)
```

## 9. 跨平台注意

- **Windows**：`sag-read-*.ps1` 调用方式 `powershell -NoProfile -ExecutionPolicy Bypass -File <path> <args>`
- **macOS/Linux**：`sag-read-*.py` 调用方式 `python3 <path> <args>`
- exe 自动根据 `.ps1` / `.py` / `.cmd` / `.exe` 后缀选解释器
- reader 脚本应当用 shebang 或文件头注释标明依赖（如 `# requires: python>=3.10, pdfplumber>=0.10`）

## 10. 示例：最小 reader（Python）

```python
#!/usr/bin/env python3
"""sag-read-pdf.py — default PDF reader."""
import sys, json

def meta():
    print(json.dumps({
        "name": "sag-read-pdf",
        "version": "1.0.0",
        "extensions": [".pdf"],
        "languages": ["zh", "en"],
        "timeoutMs": 120000,
    }))

def probe(path):
    try:
        with open(path, "rb") as f:
            head = f.read(5)
        return 0 if head.startswith(b"%PDF-") else 1
    except Exception:
        return 1

def extract(path):
    # ... 实际解析逻辑 ...
    text = "..."  # 解析得到的 markdown
    sys.stdout.write(text)
    sys.stderr.write(json.dumps({"pages": 12}) + "\n")
    return 0

if __name__ == "__main__":
    args = sys.argv[1:]
    if args and args[0] == "--meta":
        meta(); sys.exit(0)
    if args and args[0] == "--probe":
        sys.exit(probe(args[1]))
    if args:
        sys.exit(extract(args[0]))
    sys.exit(1)
```

## 11. 版本与兼容

- Spec 版本：`1`
- exe 在启动时读 `sag-readers/manifest.json` 里的 `version` 字段
- 不识别的高版本 exe 会忽略 manifest 但仍按默认顺序扫目录
- 任何 spec 改动必须同时更新 `manifest.version` 和本文档