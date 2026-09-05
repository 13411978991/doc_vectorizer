SAG — 智能审计与检索工具
=========================

Windows 单文件可执行发行包。解压后双击 黑洞.exe 即可运行，
无需安装 Node、Python 或任何第三方依赖。

目录结构
--------

  黑洞.exe                     主程序（HTTP 服务器 + MCP HTTP 服务）
  黑洞.native-map.json         原生模块映射（运行时自动解压）
  黑洞.migrations.json         数据库迁移脚本

  黑洞-mcp.exe                 MCP stdio 启动器（可选，给不支持 HTTP MCP 的客户端用）
  黑洞-mcp.native-map.json
  黑洞-mcp.migrations.json

  web\dist\                    前端构建产物（黑洞.exe 会从这里提供 Web UI）

  scripts-runtime\             运行时调用的文件解析脚本
                                extract-office.py — xlsx/xls/docx/pptx 加密文件
                                com-extract.ps1   — COM 自动化解密（DLP 文件）
                                requirements.txt  — Python 依赖（按需安装）
                                普通文件 Node 已经处理，不需要 Python

  .env.example                 配置文件模板（改名 .env 后生效）
  mcp-config.json              MCP HTTP 客户端配置样例
  mcp-config-stdio.json        MCP stdio 客户端配置样例

启动
----

1. 解压本 zip 到一个**有写权限**的目录（不要放在只读 U 盘 / Program Files）。
   首次运行会在同目录下创建 `data\`、`native-cache\` 等子目录。

2. （可选）从 `.env.example` 复制一份改名 `.env`，按需修改：
   - DATABASE_FILE=./data/sag.db        SQLite 文件位置
   - LLM_BASE_URL / LLM_API_KEY         LLM 接口（事件抽取和 rerank 用）
   - EMBEDDING_BASE_URL / EMBEDDING_API_KEY   Embedding 接口
   - MCP_TRANSPORT=stdio|http            MCP 传输方式，详见下文

3. 双击 `黑洞.exe` 启动。第一次启动会：
   - 解压原生模块到 `native-cache/<hash>\`（约 200 MB，约 1-2 秒）
   - 跑数据库迁移，建 `data/sag.db`
   - 监听 `http://127.0.0.1:4173`（Web UI）和 `http://127.0.0.1:4174/mcp`（MCP HTTP）

4. 浏览器打开 http://127.0.0.1:4173/ 即可使用。
   日志写在 exe 同目录的 `sd-out.log` 和 `sd-err.log`。

MCP 挂载方式
------------

黑洞.exe 同时支持两种 MCP 传输：

A. HTTP 传输（推荐，Windows / 远端客户端）
B. stdio 传输（传统方式，部分老客户端 / IDE 要求）

====================
A. HTTP 传输
====================

服务端 .env 配置：

    MCP_TRANSPORT=http
    MCP_HTTP_PORT=4174
    MCP_AUTH_MODE=none              # 本机用 none；对外网用 api_key
    SAG_MCP_SOURCE_ID=<uuid>        # 可选：把 MCP 锁在一个项目里

启动黑洞.exe 后，访问 http://127.0.0.1:4174/mcp 应该是 401/200（取决于 auth mode）。

客户端 MCP 配置：

    {
      "mcpServers": {
        "sag": {
          "type": "http",
          "url": "http://127.0.0.1:4174/mcp"
        }
      }
    }

如果服务端 MCP_AUTH_MODE=api_key，还需要带 X-MCP-Key：

    {
      "mcpServers": {
        "sag": {
          "type": "http",
          "url": "http://127.0.0.1:4174/mcp",
          "headers": { "X-MCP-Key": "你的key" }
        }
      }
    }

服务端生成 key：Web UI → 知识库 → MCP API Keys → New。
.env 配 MCP_AUTH_MODE=api_key + MCP_API_KEY_BACKEND=csv 时，
也可以直接 .env 里写 MCP_API_KEYS=key1,key2,key3。

====================
B. stdio 传输
====================

不需要服务端开 MCP_HTTP_PORT，stdio 客户端启动黑洞-mcp.exe，
通过 stdin/stdout 走 MCP 协议。

黑洞-mcp.exe 跟黑洞.exe 共享同一个 SQLite 数据库（默认 ./data/sag.db），
所以两个进程不能同时跑同一份 DB——只跑黑洞-mcp.exe 即可，
或者跑黑洞.exe 同时 stdio 客户端连黑洞-mcp.exe（两个进程读同一 DB 是 OK 的，
但写操作需要 SQLite 锁；推荐只跑其中一个）。

客户端 MCP 配置：

    {
      "mcpServers": {
        "sag": {
          "command": "C:\\sag\\黑洞-mcp.exe",
          "args": [],
          "env": {
            "DEFAULT_TENANT_ID": "default"
          }
        }
      }
    }

把路径改成你的实际解压目录。

要让 stdio 锁在某个项目里，加 SAG_MCP_SOURCE_ID：

    "env": {
      "DEFAULT_TENANT_ID": "default",
      "SAG_MCP_SOURCE_ID": "把你的项目 uuid 粘贴在这里"
    }

⚠️ 这一步不能跳过。**不填 SAG_MCP_SOURCE_ID 的话，sag_search 会扫整个租户的所有源，
在大数据集下基本返回空结果（query 没有 seed events，fallback 到 vector chunk 搜索也命中不到）。**
填项目 UUID 会自动展开挂载在它下面的所有自动数据源；填单个 watched folder 的 UUID
只搜那一路。

====================
项目 UUID 在哪？
====================

Web UI 进项目页 → URL 末尾的 UUID 就是。例如：

    http://127.0.0.1:4173/projects/<项目uuid>/documents

也可以这样查（从 黑洞.exe 同目录执行）：

    sqlite3 data\sag.db "SELECT id, name, kind FROM sources WHERE archived_at IS NULL"

Watched Folder（自动数据源）也是 source UUID——填项目 UUID 会自动展开
挂在它下面的所有自动数据源，等价于填那个项目的所有内容。

====================
故障排查
====================

闪退 / 启动失败：
- 看黑洞.exe 同目录下 sd-out.log 和 sd-err.log
- 确认解压目录有写权限（首次启动要写 native-cache/ 和 data/）
- C 盘空间不够会让老版本崩溃——新版本已经默认用 exe 同目录做缓存

MCP 连不上：
- 黑洞.exe 起 HTTP MCP 的话，先 curl http://127.0.0.1:4174/mcp 看返回
- AUTH_MODE=none 时应该返回 401 或 200，不是连接拒绝
- 黑洞-mcp.exe stdio 模式不会监听端口，看 stderr 有没有报错

数据库损坏 / 迁移报错：
- 删 data/sag.db 重启，会自动重建（数据会丢）

打包者：钟远声 / sunwoda audit team
联系：看 Web UI 关于页