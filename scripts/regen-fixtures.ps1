#requires -Version 5.1
# Regenerate the 6 fixture folders under D:\IT审计\SAG-windows-pack\fixtures\
# with REAL Office files (.docx / .xlsx / .pptx) that the watcher can ingest.
# Uses PowerShell COM automation against installed MS Office.
#
# Why COM and not npm libs:
#   - The npm cache / registry is unreliable here (cdn-lfs modelscope DNS
#     failures on the same machine), and we have not preinstalled docx /
#     pptxgenjs / excel4node. COM automation reuses the same Word/Excel/
#     PowerPoint installation that the watcher already drives for
#     decryption + text extraction, so file quality is what the production
#     pipeline expects.
#
# Layout (matches what iter 26/27 generated):
#   fixtures\
#     Chinese\
#       信息安全\
#         风险评估\                  (.docx-heavy, mixed .xlsx)
#       信息系统监理\
#         审计底稿\                   (.xlsx-heavy, mixed .docx)
#     LongPaths\
#       信息系统-集成项目管理-实施方案-技术规范-验收标准-全套文档\  (CJK long path, mixed)
#       审计准则2024年度更新版-中国注册会计师协会-发布稿-完整版-含附录\  (CJK long path, mixed)
#     Mixed\
#       审计-2024-Q1\
#         底稿+Workpapers\           (ASCII + CJK mix, .xlsx-heavy)
#       风险-Compliance\
#         政策法规\                  (mixed, .pptx-heavy)
#
# Per folder: 30 .docx + 10 .xlsx + 10 .pptx = 50 files.
# Total: 300 files across 6 folders.

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ProgressPreference = "SilentlyContinue"  # speed up file enumeration

$base = "D:\IT审计\SAG-windows-pack\fixtures"

# ---------------------------------------------------------------------------
# 1. Wipe the old fixture tree (CSV stubs + empty dirs from prior iter)
# ---------------------------------------------------------------------------
Write-Host "[1/3] cleaning stale fixtures under $base ..."
if (Test-Path $base) {
  # Recursive force-remove, but never the base dir itself
  Get-ChildItem -LiteralPath $base -Force | ForEach-Object {
    Remove-Item -LiteralPath $_.FullName -Recurse -Force
  }
} else {
  New-Item -ItemType Directory -Force -Path $base | Out-Null
}

# ---------------------------------------------------------------------------
# 2. Define the 6 target folders
# ---------------------------------------------------------------------------
$folders = @(
  @{ Path = "Chinese\信息安全\风险评估";                      DocxRatio = 0.7; Theme = "风险评估" },
  @{ Path = "Chinese\信息系统监理\审计底稿";                  DocxRatio = 0.4; Theme = "审计底稿" },
  @{ Path = "LongPaths\信息系统-集成项目管理-实施方案-技术规范-验收标准-全套文档";  DocxRatio = 0.6; Theme = "实施方案" },
  @{ Path = "LongPaths\审计准则2024年度更新版-中国注册会计师协会-发布稿-完整版-含附录";  DocxRatio = 0.5; Theme = "审计准则" },
  @{ Path = "Mixed\审计-2024-Q1\底稿+Workpapers";             DocxRatio = 0.3; Theme = "2024Q1" },
  @{ Path = "Mixed\风险-Compliance\政策法规";                  DocxRatio = 0.2; Theme = "Compliance" }
)

$perFolder = 50  # 30 docx + 10 xlsx + 10 pptx

# Audit-domain paragraph banks — used to seed Word documents so the file is
# not empty once Excel/Word renders it. Each theme picks one bank.
$themes = @{
  "风险评估" = @(
    "本评估覆盖信息系统全生命周期，重点关注访问控制、数据加密、操作审计三个维度。",
    "风险等级划分为高、中、低三档；高风险项须在 30 天内完成整改。",
    "采用 CVSS 3.1 评分标准，并结合公司业务影响矩阵进行二次校准。",
    "残余风险须经风险管理委员会书面确认后方可接受。",
    "本年度新增 12 类威胁场景，较去年增长 35%，主要来自供应链与第三方接入。"
  )
  "审计底稿" = @(
    "抽样总体为 2024 年第三季度新增供应商付款凭证，共 1,847 笔，金额合计 2.34 亿元。",
    "审计程序包括穿行测试、控制测试、实质性测试三个阶段。",
    "抽样方法采用货币单元抽样，样本量根据风险评估结果确定。",
    "关键控制点：合同审批流、发票三单匹配、付款审批层级。",
    "已发现 3 例例外事项，金额合计 23.5 万元，建议管理层关注。"
  )
  "实施方案" = @(
    "项目目标：完成核心业务系统国产化替换，确保 2025 年 Q2 全部上线。",
    "实施范围：ERP、CRM、HR、财务核算四个核心模块。",
    "技术路线：X86 + 麒麟操作系统 + 达梦数据库 + 中间件东方通。",
    "里程碑：需求确认 2024-09 / 环境搭建 2024-12 / UAT 2025-03 / 切换 2025-05。",
    "风险控制：并行运行期不少于 3 个月，月度对账偏差率 < 0.01%。"
  )
  "审计准则" = @(
    '本准则依据《中国注册会计师审计准则第 1211 号——了解被审计单位及其环境》制定。',
    '适用范围：上市公司财务报表审计及非上市企业按准则约定执行的审计业务。',
    '重大错报风险包括财务报表层次和认定层次两个层面。',
    '注册会计师应当对被审计单位的内部控制进行了解与评价。',
    '2024 年度更新重点：增加对网络安全事件、合规风险的识别与应对要求。'
  )
  "2024Q1" = @(
    "Q1 total revenue reached 187M RMB, up 23.6% YoY, driven by SaaS subscriptions.",
    "Working papers include trial balance, lead schedule, and substantive procedures.",
    "Sample selection: 60 out of 1,200 journal entries, stratified by amount.",
    "No material misstatement identified; 3 control deficiencies noted for follow-up.",
    "Subsequent events: none through the date of this report (2024-04-15)."
  )
  "Compliance" = @(
    "Compliance scope: data privacy (PIPL), cybersecurity law, and cross-border transfer.",
    "Sensitive personal information requires separate consent and encryption at rest.",
    "Cross-border data transfer must pass CAC security assessment or standard contract.",
    "Annual compliance audit due 2024-12-31; mid-year self-assessment due 2024-06-30.",
    "Penalties for non-compliance may include fines up to 5% of annual revenue."
  )
}

# ---------------------------------------------------------------------------
# 3. Spawn Office COM + iterate folders
# ---------------------------------------------------------------------------
Write-Host "[2/3] spawning Office COM objects ..."

$word   = New-Object -ComObject Word.Application
$excel  = New-Object -ComObject Excel.Application
$pp     = New-Object -ComObject PowerPoint.Application

$word.Visible   = $false
$excel.Visible  = $false
# PowerPoint refuses to hide the application window ("Hiding the
# application window is not allowed"). Leave Visible = msoTrue but pass
# WithWindow: msoFalse to Presentations.Add() so each presentation is
# created off-screen and no user-visible chrome appears during the
# generation run. We still set DisplayAlerts to ppAlertsNone so
# confirmation prompts don't block.
$pp.Visible     = [Microsoft.Office.Core.MsoTriState]::msoTrue

# Suppress alert dialogs (e.g. "This document contains macros...") that
# would otherwise block the headless COM run.
$word.DisplayAlerts   = 0   # wdAlertsNone
$excel.DisplayAlerts  = $false
$pp.DisplayAlerts     = 1   # ppAlertsNone (PpAlertLevel enum integer value)

# Make SaveAs2 deterministic across machines (default Office behaviour
# varies by locale; force modern Office Open XML formats).
$wdFormatXML = 16          # wdFormatXMLDocument for .docx
$xlOpenXML  = 51           # xlOpenXMLWorkbook for .xlsx
$ppFormat   = 24           # ppSaveAsOpenXMLPresentation for .pptx

Write-Host "[3/3] generating files ..."

$totalFiles = 0
foreach ($folder in $folders) {
  $folderPath = Join-Path $base $folder.Path
  New-Item -ItemType Directory -Force -Path $folderPath | Out-Null
  $themeKey = $folder.Theme
  $themeText = $themes[$themeKey]

  # Decide split: docxRatio of 50 goes to .docx; remainder split 50/50
  # between .xlsx and .pptx so we end up with 50 files / folder.
  $docxCount = [int]([math]::Round($perFolder * $folder.DocxRatio))
  $xlsxCount = [int]([math]::Floor(($perFolder - $docxCount) / 2))
  $pptxCount = $perFolder - $docxCount - $xlsxCount

  $folderCounter = 0
  Write-Host ""
  Write-Host "  -> $($folder.Path)  ($docxCount docx + $xlsxCount xlsx + $pptxCount pptx)"

  # ---- .docx files --------------------------------------------------------
  for ($i = 0; $i -lt $docxCount; $i++) {
    $folderCounter++
    $fileName = "{0:D4}_{1}_{2}.docx" -f $i, $themeKey, $folderCounter
    $filePath = Join-Path $folderPath $fileName
    Write-Host "    [docx $($i+1)/$docxCount] $fileName"
    # Use explicit positional args to skip the "look up default Normal.dotm"
    # path that hangs Word COM on first-ever run for a user profile.
    $doc = $word.Documents.Add("", $false, 0, $false)
    $para = $doc.Content.Paragraphs.Add()
    $para.Range.Text = "$themeKey 报告 #$($folderCounter.ToString('D3'))`r`n"
    $para.Range.Font.Size = 16
    $para.Range.Font.Bold = $true
    foreach ($line in $themeText) {
      $p2 = $doc.Content.Paragraphs.Add()
      $p2.Range.Text = "$line`r`n"
      $p2.Range.Font.Size = 11
    }
    $doc.SaveAs2($filePath, $wdFormatXML)
    $doc.Close($false)
    [System.Runtime.Interopservices.Marshal]::ReleaseComObject($para) | Out-Null
    [System.Runtime.Interopservices.Marshal]::ReleaseComObject($doc) | Out-Null
    $totalFiles++
  }

  # ---- .xlsx files --------------------------------------------------------
  for ($i = 0; $i -lt $xlsxCount; $i++) {
    $folderCounter++
    $fileName = "{0:D4}_{1}_workpaper_{2}.xlsx" -f $i, $themeKey, $folderCounter
    $filePath = Join-Path $folderPath $fileName
    Write-Host "    [xlsx $($i+1)/$xlsxCount] $fileName"
    $wb = $excel.Workbooks.Add("", $false)
    $ws = $wb.Worksheets.Item(1)
    $ws.Name = $themeKey.Substring(0, [Math]::Min(31, $themeKey.Length))
    $ws.Cells.Item(1, 1) = "Workpaper #$($folderCounter)"
    $ws.Cells.Item(2, 1) = "Item"
    $ws.Cells.Item(2, 2) = "Amount"
    $ws.Cells.Item(2, 3) = "Note"
    $ws.Range("A1:C1").Font.Bold = $true
    for ($row = 3; $row -le 12; $row++) {
      $ws.Cells.Item($row, 1) = "Sample $row"
      $ws.Cells.Item($row, 2) = [math]::Round((Get-Random -Minimum 100 -Maximum 99999), 2)
      $ws.Cells.Item($row, 3) = $themeText[$row % $themeText.Length]
    }
    $ws.Columns.AutoFit() | Out-Null
    $wb.SaveAs($filePath, $xlOpenXML)
    $wb.Close($false)
    [System.Runtime.Interopservices.Marshal]::ReleaseComObject($ws) | Out-Null
    [System.Runtime.Interopservices.Marshal]::ReleaseComObject($wb) | Out-Null
    $totalFiles++
  }

  # ---- .pptx files --------------------------------------------------------
  for ($i = 0; $i -lt $pptxCount; $i++) {
    $folderCounter++
    $fileName = "{0:D4}_{1}_slides_{2}.pptx" -f $i, $themeKey, $folderCounter
    $filePath = Join-Path $folderPath $fileName
    Write-Host "    [pptx $($i+1)/$pptxCount] $fileName"
    $pres = $pp.Presentations.Add([Microsoft.Office.Core.MsoTriState]::msoFalse)
    $slide1 = $pres.Slides.Add(1, 1)  # 1 = ppLayoutTitle
    $slide1.Shapes.Title.TextFrame.TextRange.Text = "$themeKey Slides #$($folderCounter)"
    $slide1.Shapes.Item(2).TextFrame.TextRange.Text = $themeText[0]
    for ($s = 2; $s -le 4; $s++) {
      $slideN = $pres.Slides.Add($s, 2)  # 2 = ppLayoutText
      $slideN.Shapes.Title.TextFrame.TextRange.Text = "Section $s"
      $slideN.Shapes.Item(2).TextFrame.TextRange.Text = $themeText[$s - 1]
    }
    $pres.SaveAs($filePath, $ppFormat)
    $pres.Close()
    [System.Runtime.Interopservices.Marshal]::ReleaseComObject($pres) | Out-Null
    $totalFiles++
  }
}

Write-Host ""
Write-Host "[done] generated $totalFiles files across $($folders.Count) folders"

# Quit Office COM (but cleanly; leave Excel/Word running otherwise the next
# COM spawn can fail with "the RPC server is unavailable")
$word.Quit()
$excel.Quit()
$pp.Quit()

[System.Runtime.Interopservices.Marshal]::ReleaseComObject($word)   | Out-Null
[System.Runtime.Interopservices.Marshal]::ReleaseComObject($excel)  | Out-Null
[System.Runtime.Interopservices.Marshal]::ReleaseComObject($pp)     | Out-Null

# Force GC to release the COM RCWs so the OS Office processes can exit.
[GC]::Collect()
[GC]::WaitForPendingFinalizers()