// Generate the 6 fixture folders under D:\IT审计\SAG-windows-pack\fixtures\
// with REAL Office Open XML files (.docx / .xlsx / .pptx) using JSZip.
// These are valid OOXML packages: Office, LibreOffice, and the watcher's
// mammoth/xlsx parsers all open them.
//
// Why not PowerShell COM automation:
//   - On this machine, the very first Documents.Add() in a loop hangs
//     indefinitely (Office tries to reach an Office Online cloud service
//     that DNS blocks; we already burned 4 minutes waiting for it).
//   - The same machine's npm registry mirror is reachable, so JSZip is
//     available and we can build real OOXML zip packages ourselves
//     without ever spawning Office.
//
// OOXML format reference:
//   .docx is a ZIP with [Content_Types].xml, _rels/.rels, word/document.xml
//   .xlsx is a ZIP with [Content_Types].xml, _rels/.rels, xl/workbook.xml,
//              xl/worksheets/sheet1.xml, xl/styles.xml, xl/_rels/workbook.xml.rels
//   .pptx is a ZIP with [Content_Types].xml, _rels/.rels, ppt/presentation.xml,
//              ppt/slides/slide1.xml, ppt/slideLayouts/slideLayout1.xml

import JSZip from "jszip";
import { mkdir, writeFile, rm, stat } from "node:fs/promises";
import { join, dirname } from "node:path";

// ------------------------------------------------------------------
// Audit-domain paragraph banks, one per theme. Picked by folder.
// ------------------------------------------------------------------
const THEMES = {
  "风险评估": [
    "本评估覆盖信息系统全生命周期，重点关注访问控制、数据加密、操作审计三个维度。",
    "风险等级划分为高、中、低三档；高风险项须在 30 天内完成整改。",
    "采用 CVSS 3.1 评分标准，并结合公司业务影响矩阵进行二次校准。",
    "残余风险须经风险管理委员会书面确认后方可接受。",
    "本年度新增 12 类威胁场景，较去年增长 35%，主要来自供应链与第三方接入。"
  ],
  "审计底稿": [
    "抽样总体为 2024 年第三季度新增供应商付款凭证，共 1,847 笔，金额合计 2.34 亿元。",
    "审计程序包括穿行测试、控制测试、实质性测试三个阶段。",
    "抽样方法采用货币单元抽样，样本量根据风险评估结果确定。",
    "关键控制点：合同审批流、发票三单匹配、付款审批层级。",
    "已发现 3 例例外事项，金额合计 23.5 万元，建议管理层关注。"
  ],
  "实施方案": [
    "项目目标：完成核心业务系统国产化替换，确保 2025 年 Q2 全部上线。",
    "实施范围：ERP、CRM、HR、财务核算四个核心模块。",
    "技术路线：X86 + 麒麟操作系统 + 达梦数据库 + 中间件东方通。",
    "里程碑：需求确认 2024-09 / 环境搭建 2024-12 / UAT 2025-03 / 切换 2025-05。",
    "风险控制：并行运行期不少于 3 个月，月度对账偏差率 < 0.01%。"
  ],
  "审计准则": [
    "本准则依据《中国注册会计师审计准则第 1211 号——了解被审计单位及其环境》制定。",
    "适用范围：上市公司财务报表审计及非上市企业按准则约定执行的审计业务。",
    "重大错报风险包括财务报表层次和认定层次两个层面。",
    "注册会计师应当对被审计单位的内部控制进行了解与评价。",
    "2024 年度更新重点：增加对网络安全事件、合规风险的识别与应对要求。"
  ],
  "2024Q1": [
    "Q1 total revenue reached 187M RMB, up 23.6% YoY, driven by SaaS subscriptions.",
    "Working papers include trial balance, lead schedule, and substantive procedures.",
    "Sample selection: 60 out of 1,200 journal entries, stratified by amount.",
    "No material misstatement identified; 3 control deficiencies noted for follow-up.",
    "Subsequent events: none through the date of this report (2024-04-15)."
  ],
  "Compliance": [
    "Compliance scope: data privacy (PIPL), cybersecurity law, and cross-border transfer.",
    "Sensitive personal information requires separate consent and encryption at rest.",
    "Cross-border data transfer must pass CAC security assessment or standard contract.",
    "Annual compliance audit due 2024-12-31; mid-year self-assessment due 2024-06-30.",
    "Penalties for non-compliance may include fines up to 5% of annual revenue."
  ]
};

// 6 fixture folders
const FOLDERS = [
  { path: "Chinese\\信息安全\\风险评估",                    docxRatio: 0.7, theme: "风险评估" },
  { path: "Chinese\\信息系统监理\\审计底稿",                docxRatio: 0.4, theme: "审计底稿" },
  { path: "LongPaths\\信息系统-集成项目管理-实施方案-技术规范-验收标准-全套文档", docxRatio: 0.6, theme: "实施方案" },
  { path: "LongPaths\\审计准则2024年度更新版-中国注册会计师协会-发布稿-完整版-含附录", docxRatio: 0.5, theme: "审计准则" },
  { path: "Mixed\\审计-2024-Q1\\底稿+Workpapers",            docxRatio: 0.3, theme: "2024Q1" },
  { path: "Mixed\\风险-Compliance\\政策法规",                docxRatio: 0.2, theme: "Compliance" }
];
const PER_FOLDER = 50;
const BASE = "D:\\IT审计\\SAG-windows-pack\\fixtures";

// ------------------------------------------------------------------
// XML helpers (escape &, <, > in user-supplied text)
// ------------------------------------------------------------------
function xml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ------------------------------------------------------------------
// DOCX builder
// ------------------------------------------------------------------
async function buildDocx(themeKey, idx, themeText) {
  const title = `${themeKey} 报告 #${String(idx).padStart(3, "0")}`;
  const paragraphs = [
    `<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="32"/></w:rPr><w:t xml:space="preserve">${xml(title)}</w:t></w:r></w:p>`
  ];
  for (const line of themeText) {
    paragraphs.push(
      `<w:p><w:r><w:rPr><w:sz w:val="22"/></w:rPr><w:t xml:space="preserve">${xml(line)}</w:t></w:r></w:p>`
    );
  }
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    ${paragraphs.join("\n    ")}
    <w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr>
  </w:body>
</w:document>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;
  const zip = new JSZip();
  zip.file("[Content_Types].xml", contentTypes);
  zip.file("_rels/.rels", rels);
  zip.file("word/document.xml", documentXml);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

// ------------------------------------------------------------------
// XLSX builder
// ------------------------------------------------------------------
async function buildXlsx(themeKey, idx, themeText) {
  const sheetName = themeKey.substring(0, Math.min(31, themeKey.length));
  const rows = [
    `<row r="1"><c r="A1" t="inlineStr"><is><t>Workpaper #${idx}</t></is></c><c r="B1" t="inlineStr"><is><t>${xml(themeKey)}</t></is></c><c r="C1" t="inlineStr"><is><t>Date 2024-12</t></is></c></row>`,
    `<row r="2"><c r="A2" t="inlineStr"><is><t>Item</t></is></c><c r="B2" t="inlineStr"><is><t>Amount</t></is></c><c r="C2" t="inlineStr"><is><t>Note</t></is></c></row>`
  ];
  for (let r = 3; r <= 12; r++) {
    const amt = Math.round(100 + Math.random() * 99899);
    const note = themeText[r % themeText.length];
    rows.push(
      `<row r="${r}"><c r="A${r}" t="inlineStr"><is><t>Sample ${r}</t></is></c><c r="B${r}"><v>${amt}</v></c><c r="C${r}" t="inlineStr"><is><t>${xml(note)}</t></is></c></row>`
    );
  }
  const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>${rows.join("")}</sheetData>
</worksheet>`;
  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
          xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="${xml(sheetName)}" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;
  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="2"><font><sz val="11"/></font><font><b/><sz val="11"/></font></fonts>
  <fills count="1"><fill><patternFill patternType="none"/></fill></fills>
  <borders count="1"><border/></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="2">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
  </cellXfs>
</styleSheet>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;
  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;
  const zip = new JSZip();
  zip.file("[Content_Types].xml", contentTypes);
  zip.file("_rels/.rels", rels);
  zip.file("xl/workbook.xml", workbookXml);
  zip.file("xl/_rels/workbook.xml.rels", workbookRels);
  zip.file("xl/worksheets/sheet1.xml", sheetXml);
  zip.file("xl/styles.xml", stylesXml);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

// ------------------------------------------------------------------
// PPTX builder (minimal — 4 slides per deck)
// ------------------------------------------------------------------
async function buildPptx(themeKey, idx, themeText) {
  const slides = [];
  const totalSlides = 4;
  for (let s = 1; s <= totalSlides; s++) {
    const titleText = s === 1 ? `${themeKey} Slides #${idx}` : `Section ${s}`;
    const bodyText = themeText[(s - 1) % themeText.length];
    slides.push(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
       xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
       xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree>
    <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
    <p:grpSpPr/>
    <p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr txBox="0"/><p:nvPr/></p:nvSpPr>
      <p:spPr><a:xfrm><a:off x="457200" y="274680"/><a:ext cx="8229240" cy="1142640"/></a:xfrm><a:prstGeom prst="rect"/></p:spPr>
      <p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="zh-CN" sz="3200" b="1"/><a:t>${xml(titleText)}</a:t></a:r></a:p></p:txBody>
    </p:sp>
    <p:sp><p:nvSpPr><p:cNvPr id="3" name="Body"/><p:cNvSpPr txBox="0"/><p:nvPr/></p:nvSpPr>
      <p:spPr><a:xfrm><a:off x="457200" y="1600200"/><a:ext cx="8229240" cy="4525560"/></a:xfrm><a:prstGeom prst="rect"/></p:spPr>
      <p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="zh-CN" sz="2000"/><a:t>${xml(bodyText)}</a:t></a:r></a:p></p:txBody>
    </p:sp>
  </p:spTree></p:cSld>
</p:sld>`);
  }
  const presentationXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
                xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
                xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>
  <p:sldIdLst>${Array.from({ length: totalSlides }, (_, i) =>
    `<p:sldId id="${256 + i}" r:id="rId${10 + i}"/>`
  ).join("")}</p:sldIdLst>
  <p:sldSz cx="9144000" cy="6858000" type="screen4x3"/>
  <p:notesSz cx="6858000" cy="9144000"/>
</p:presentation>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  ${Array.from({ length: totalSlides }, (_, i) =>
    `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`
  ).join("")}
  <Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>
  <Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>
</Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>`;
  const presentationRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="slideLayouts/slideLayout1.xml"/>
  ${Array.from({ length: totalSlides }, (_, i) =>
    `<Relationship Id="rId${10 + i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`
  ).join("")}
</Relationships>`;
  const slideMasterXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
             xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld>
</p:sldMaster>`;
  const slideLayoutXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
             xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
             type="blank" preserve="1">
  <p:cSld name="Blank Slide"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld>
</p:sldLayout>`;
  const zip = new JSZip();
  zip.file("[Content_Types].xml", contentTypes);
  zip.file("_rels/.rels", rels);
  zip.file("ppt/presentation.xml", presentationXml);
  zip.file("ppt/_rels/presentation.xml.rels", presentationRels);
  zip.file("ppt/slideMasters/slideMaster1.xml", slideMasterXml);
  zip.file("ppt/slideLayouts/slideLayout1.xml", slideLayoutXml);
  for (let i = 0; i < totalSlides; i++) {
    zip.file(`ppt/slides/slide${i + 1}.xml`, slides[i]);
  }
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

// ------------------------------------------------------------------
// main
// ------------------------------------------------------------------
async function main() {
  console.log(`[1/3] wiping ${BASE}`);
  try { await rm(BASE, { recursive: true, force: true }); } catch {}

  let total = 0;
  for (const folder of FOLDERS) {
    const folderPath = join(BASE, folder.path);
    await mkdir(folderPath, { recursive: true });
    const themeText = THEMES[folder.theme];
    const docxCount = Math.round(PER_FOLDER * folder.docxRatio);
    const remaining = PER_FOLDER - docxCount;
    const xlsxCount = Math.floor(remaining / 2);
    const pptxCount = remaining - xlsxCount;
    console.log(`[2/3] ${folder.path}: ${docxCount} docx + ${xlsxCount} xlsx + ${pptxCount} pptx`);
    let n = 0;

    for (let i = 0; i < docxCount; i++) {
      n++;
      const buf = await buildDocx(folder.theme, n, themeText);
      const name = `${String(i).padStart(4, "0")}_${folder.theme}_${n}.docx`;
      await writeFile(join(folderPath, name), buf);
      total++;
    }
    for (let i = 0; i < xlsxCount; i++) {
      n++;
      const buf = await buildXlsx(folder.theme, n, themeText);
      const name = `${String(i).padStart(4, "0")}_${folder.theme}_workpaper_${n}.xlsx`;
      await writeFile(join(folderPath, name), buf);
      total++;
    }
    for (let i = 0; i < pptxCount; i++) {
      n++;
      const buf = await buildPptx(folder.theme, n, themeText);
      const name = `${String(i).padStart(4, "0")}_${folder.theme}_slides_${n}.pptx`;
      await writeFile(join(folderPath, name), buf);
      total++;
    }
  }
  console.log(`[3/3] done — ${total} files across ${FOLDERS.length} folders`);
}

main().catch((e) => { console.error(e); process.exit(1); });