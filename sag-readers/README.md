# sag-readers/ — Agent 自助编写 Reader 脚本指南

> 适用对象：在另一台电脑上运行 SAG 桌面版的 agent。这台电脑可能装了 Office、可能装了 WPS、可能装在 DLP/加密环境下、也可能什么都没有。

## 1. 一句话总览

`SAG.exe`（SAG 后端）**不直接读文件**。它把"读 docx → 得到文本"的工作完全外包给 `sag-readers/` 目录里的脚本。你只需要按本指南写一个脚本，然后用 **`sag-reader-validator.exe`** 验证它。验证通过的 reader 才能被SAG.exe 调用。验证不通过的 reader 直接被忽略，SAG.exe 退回内置 Node 解析器（仍然能跑，只是不支持加密/特殊环境）。

**三件事**：
1. 探测你的电脑环境（有没有 Office / WPS / Python / 加密软件）
2. 按 SPEC.md 协议写一个 reader 脚本（Python 或 PowerShell）
3. 用 `sag-reader-validator.exe` 跑一遍，生成 `.sag-validator-cert.json` 证书
4. SAG.exe 下次启动时会自动检查证书，没证书或证书不合格的 reader 都会被跳过

## 2. 第一步：探测环境

写一个一次性探测脚本（在 agent 自己 scratch 区，不要污染 sag-readers/）：

```python
# probe-env.py — 一次性环境探测
import os, sys, subprocess, json

def has_cmd(name):  # PATH 上能跑
    return subprocess.run(["where", name], capture_output=True).returncode == 0

def has_com(progid):
    """Windows COM 检测：通过 PowerShell 试 new COM 对象"""
    if os.name != "nt":
        return False
    ps = f'(New-Object -ComObject "{progid}" -ErrorAction SilentlyContinue) -ne $null'
    return subprocess.run(["powershell", "-NoProfile", "-Command", ps],
                          capture_output=True).returncode == 0

def python_version():
    try:
        return subprocess.run([sys.executable, "--version"],
                              capture_output=True, text=True).stdout.strip()
    except Exception:
        return None

def python_pkg(pkg):
    try:
        r = subprocess.run([sys.executable, "-c", f"import {pkg}; print({pkg}.__version__)"],
                          capture_output=True, text=True, timeout=5)
        return r.returncode == 0
    except Exception:
        return False

env = {
    "os": sys.platform,
    "python": python_version(),
    "python_packages": {
        "openpyxl": python_pkg("openpyxl"),
        "mammoth":   python_pkg("mammoth"),
        "pdfplumber": python_pkg("pdfplumber"),
        "python_pptx": python_pkg("pptx"),
    },
    "node": has_cmd("node"),
    "powershell": has_cmd("powershell"),
    "office_com": {  # 加密文件才会用到
        "Word":    has_com("Word.Application"),
        "Excel":   has_com("Excel.Application"),
        "PowerPoint": has_com("PowerPoint.Application"),
    },
    "wps_com": {  # 加密环境的备选 COM
        "Writer": has_com("KWPS.Application"),
        "Spreadsheet": has_com("KET.Application"),
        "Presentation": has_com("KWPP.Application"),
    },
    # DLP 探测：常见的 SafeNetLOCK / 亿赛通 / 奇安信 / 深信服
    "dlp_suspected": {
        "SafeNet": any(p.lower().startswith("e-safenet-")
                        for p in os.listdir(os.path.expanduser("~"))
                        if os.path.isdir(os.path.expanduser("~"))) if os.name == "nt" else False,
        "WPS_EncryptionMarker": os.name == "nt" and has_com("KWPS.Application"),
    },
}

print(json.dumps(env, ensure_ascii=False, indent=2))
```

把这段脚本跑一遍，根据输出决定走哪条路径：

| 情况 | 标志 | 走哪条 |
|---|---|---|
| 干净环境，文件没加密 | `office_com` 全 false + `dlp_suspected` false | 纯 Python reader（mammoth/openpyxl/python-pptx/pdfplumber） |
| Office 装好了 | `office_com.Word/Excel/PowerPoint` true | Python reader 优先 + Office COM fallback reader |
| 只有 WPS（国产替代） | `wps_com.Writer/Spreadsheet/Presentation` true | Python reader + WPS COM fallback reader |
| DLP 加密环境 | `dlp_suspected.SafeNet` true 或类似 | **直接用 COM reader**（Python 解不开 DLP 加密文件） |
| 啥都没有 | 全 false | SAG.exe 退回内置 fallback，reader 是 best-effort |

**判断完成后**，在 `sag-readers/` 下创建对应 reader：

- 干净环境 → `sag-read-docx.py`、`sag-read-xlsx.py`、…（每种文件一个）
- 加密环境 → `sag-read-docx-encrypted.ps1` 之类（COM 解密优先；命名按 SPEC.md §1 的"扩展名在前 + 可选 variant"规则）
- 一个电脑可以放多个变体，SAG.exe 按文件名字典序选 --probe 第一个返回 0 的

## 3. 第二步：写 reader

读 SPEC.md — 它定义了完整的调用协议（`--meta` / `--probe` / 主调用三段）。下面是最小模板。

### 3.1 干净环境：Python reader（mammoth 读 docx）

文件名：`sag-read-docx.py`

```python
#!/usr/bin/env python3
"""sag-read-docx.py — extract text from .docx via mammoth."""
import sys, json, pathlib

def meta():
    print(json.dumps({
        "name": "sag-read-docx",
        "version": "1.0.0",
        "extensions": [".docx"],
        "languages": ["zh", "en"],
        "timeoutMs": 60000,
        "needs": ["python>=3.10", "mammoth>=1.6"],
    }, ensure_ascii=False))

def probe(path):
    try:
        with open(path, "rb") as f:
            head = f.read(4)
        # docx 是 zip，magic 是 PK\x03\x04
        return 0 if head.startswith(b"PK\x03\x04") else 1
    except Exception:
        return 1

def extract(path):
    import mammoth
    with open(path, "rb") as f:
        result = mammoth.extract_raw_text(f)
    print("# " + pathlib.Path(path).name)
    print("")
    print(result.value)
    # stderr 给 exe 看元数据
    print(json.dumps({"bytes": pathlib.Path(path).stat().st_size}), file=sys.stderr)

if __name__ == "__main__":
    args = sys.argv[1:]
    if not args:
        sys.exit(1)
    if args[0] == "--meta":
        meta(); sys.exit(0)
    if args[0] == "--probe":
        sys.exit(probe(args[1]))
    sys.exit(extract(args[0]) or 0)
```

### 3.2 加密环境：PowerShell COM reader（Office / WPS）

文件名：`sag-read-docx-corp.ps1`

参考 `sag-read-office-encrypted.ps1` — 它已经实现完整的 Office + WPS 双 COM fallback。**直接拷贝使用**就行，把它放到 sag-readers/ 目录、改一下扩展名匹配规则即可（或者不动，按 SPEC.md §1 的 priority 规则让它优先胜出）。

如果需要定制（公司强制 WPS、不允许 Office），照下面这个最小模板写：

```powershell
# sag-read-docx-corp.ps1 — DLP 加密环境专用，WPS COM 优先
param([string]$InputPath, [switch]$Probe, [switch]$Meta)

$ErrorActionPreference = "Stop"

function Send-Meta {
    [Console]::Out.WriteLine((@{
        name       = "sag-read-docx-corp"
        version    = "1.0.0"
        extensions = @(".docx")
        languages  = @("zh", "en")
        timeoutMs  = 600000
        needs      = @("powershell", "wps-or-office")
    } | ConvertTo-Json -Compress))
}

function Test-Probe([string]$path) {
    if (-not (Test-Path -LiteralPath $path)) { return 1 }
    $ext = [System.IO.Path]::GetExtension($path).ToLower()
    if ($ext -ne ".docx") { return 1 }
    return 0
}

function Convert-Docx([string]$path) {
    # 尝试 WPS，失败回退 Office
    $progs = @("KWPS.Application", "Word.Application")
    $app = $null
    foreach ($p in $progs) {
        try { $app = New-Object -ComObject $p -ErrorAction Stop; break } catch {}
    }
    if (-not $app) { throw "no COM server available" }
    
    try {
        $app.Visible = $false
        $app.DisplayAlerts = 0
        $doc = $app.Documents.Open($path, $false, $true)  # ReadOnly
        try {
            [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
            [Console]::Out.WriteLine("# " + [System.IO.Path]::GetFileName($path))
            [Console]::Out.WriteLine("")
            [Console]::Out.WriteLine($doc.Content.Text)
        } finally {
            $doc.Close($false)
            [System.Runtime.Interopservices.Marshal]::ReleaseComObject($doc) | Out-Null
        }
        $app.Quit()
    } finally {
        [System.Runtime.Interopservices.Marshal]::ReleaseComObject($app) | Out-Null
        [GC]::Collect()
    }
}

if ($Meta) { Send-Meta; exit 0 }
if ($Probe) { exit (Test-Probe $InputPath) }
if (-not $InputPath) {
    [Console]::Error.WriteLine("usage: sag-read-docx-corp.ps1 [--meta|--probe F] <file>")
    exit 1
}
try {
    Convert-Docx $InputPath
    exit 0
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 3  # transient
}
```

### 3.3 加密文件最佳实践

- 永远用 **ReadOnly 模式**打开，绝不修改原文件
- `$app.Visible = $false` 但 PowerPoint 例外（必须 msoTrue）；参见 SPEC 备注
- `DisplayAlerts = 0`（office 内部 integer 1 = wdAlertsNone，不要用 `[Microsoft.Office.Core.MsoTriState]`）
- 最后 `$app.Quit()` + `ReleaseComObject` + `[GC]::Collect()`，否则 EXCEL.EXE 会变成孤儿进程

## 4. 第三步：用校验器验证

跑：

```
sag-reader-validator.exe --validate sag-read-docx.py --probe-file tests/sample.docx
```

校验器会做以下 12 项检查（**任何一项不通过都生成不了证书**）：

| #  | 检查项 | 失败表现 |
|----|--------|---------|
| 1  | 文件名匹配 `sag-read-<ext>[.<variant>].<lang>` | 命名错 |
| 2  | `--meta` 退出码 0 | 协议不符 |
| 3  | `--meta` 输出是合法 JSON，包含 `name`/`extensions`/`languages` 字段 | 元数据缺 |
| 4  | `--meta` 声明的 extensions 包含本文件名里的 ext | 自相矛盾 |
| 5  | `--probe <测试文件>` 退出码 0 | 探测失败 |
| 6  | `--probe <无关文件>` 退出码 1 | 没拒绝异类 |
| 7  | 主调用退出码 0 | 读文件失败 |
| 8  | stdout 是合法 UTF-8，无 BOM，LF 行尾 | 输出格式错 |
| 9  | stderr 是合法 JSON（可空 `{}`） | 元数据格式错 |
| 10 | 输出非空且不含二进制乱码（控制字符 < 5%） | 内容不可信 |
| 11 | 内存峰值 < 500 MB | 资源失控 |
| 12 | 总耗时 < timeoutMs | 超时 |

全部通过 → 在 reader 同目录生成 `.sag-validator-cert.json`，包含：
- reader 绝对路径
- 校验器二进制 SHA-256（防伪）
- 各项检查的 hash 快照
- HMAC 签名（用校验器私钥，**SAG.exe 用嵌入的对应公钥验签**）
- 颁发时间

## 5. 第四步：部署

把 `sag-read-docx.py` 和 `.sag-validator-cert.json` **一起**放进SAG.exe 安装目录下的 `resources/sag-readers/`。

下次SAG.exe 启动时：
1. 扫 sag-readers/ 目录
2. 对每个 reader，**先查 .sag-validator-cert.json**
3. 验签失败或文件过期 → 跳过这个 reader，记 warning log
4. 验签通过 → 跑 `--probe`，选第一个返回 0 的

无证书的 reader → SAG.exe 不会用，直接 fallback 到内置 Node 解析器（仍能跑，但可能处理不了加密文件）。

## 6. 校验器为什么不能被篡改？

校验器的二进制 SHA-256 烧死在SAG.exe 源码里（编译期常量）。如果 agent（或任何 AI）改了 `tools/sag-reader-validator/` 下的源码、自己 rebuild，得到的新二进制 SHA 跟SAG.exe 期望的对不上 → **该校验器签发的所有证书都作废**。所以只有官方源码（这里 git 上 review 过的）build 出来的二进制才能签发有效证书。

黑进SAG.exe 改 SHA 常量 → 那已经是另一种攻击了，得改 release 包本身，超出本指南范围。

## 7. 调试 checklist

- [ ] `python sag-readers/sag-read-xxx.py --meta` 单独跑过，看输出是合法 JSON
- [ ] `python sag-readers/sag-read-xxx.py --probe <file>` 单独跑过，确认对支持的文件返 0、不支持的返 1
- [ ] `python sag-readers/sag-read-xxx.py <file>` 单独跑过，确认 stdout 是 markdown 文本、stderr 是 JSON、exit 0
- [ ] 校验器跑过：`sag-reader-validator.exe --validate <reader> --probe-file <test>`
- [ ] `.sag-validator-cert.json` 在 reader 旁边
- [ ] SAG.exe 启动后 log 里看到 `reader dispatch: <reader>` 才算生效
- [ ] 没生效的话检查：cert 是否在同目录？cert HMAC 验签是否过？是否被SAG.exe 跳过了？

## 8. 出错时回退路径

- 校验器某项不过 → 改 reader 后重跑校验器，**别手动写证书**（HMAC 会验不过）
- SAG.exe 跳过 reader → 看 `sag-YYYY-MM-DD.log` 里的 `reader cert invalid` 警告
- Reader 跑得起来但内容错 → reader 内部 bug，不影响 cert；调 reader 后重跑校验
- Reader 是最稀缺资源：宁可 5 个 reader 全失败、也别让 1 个 reader 输出错误文本进库
