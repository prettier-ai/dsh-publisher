# dsh-publisher

[English](./README.md) | 中文

独立发布器：将官方 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的正式发布重新发布到 npm 的 [`@prettier-ai`](https://www.npmjs.com/org/prettier-ai) 作用域。入口包为 `@prettier-ai/dsh`；它依赖的全部 workspace 包均以 `@prettier-ai/*` 发布。版本号与官方发布完全一致。

## 本仓库是什么

- 一个轮询器：定时 workflow 读取官方仓库最新的 GitHub Release，判断该版本是否仍需要发布到 `@prettier-ai`。
- 一个重发布器：当版本缺失时，workflow 将官方 tag 拉取到 runner 工作区，把可发布包名从 `@deepseek-ai/*` 改写为 `@prettier-ai/*`（仅针对打包路径的改写，不做产品改名），然后在该检出上打包并发布。
- 两个脚本及其单元测试：`scripts/probe-upstream-release.ts`（决策）和 `scripts/rescope-to-prettier-ai.ts`（改写）。

## 本仓库不是什么

- 不是 Harness 源码树的 fork 或镜像。这里不提交任何 Harness 源码，同步 workflow 也从不把改写后的源码推回来。`git clone` 本仓库始终很小。
- 不是 Harness 的开发场所。Harness 本身的问题请报给上游。
- 不是品牌重塑。发布出的 tarball 保留上游 `DeepSeek Harness` 的产品命名、文档和 MIT 许可证文本（含 DeepSeek 版权声明）；仅 npm 包名更换作用域。

## 轮询如何工作

`.github/workflows/sync-upstream-release.yml` 按 `*/5 * * * *`（UTC）计划运行，也支持手动触发。GitHub cron 是尽力而为的：运行可能漂移数分钟或在高负载时被丢弃；下一次运行会补上。

轻量的 `decide` 作业仅稀疏检出 `scripts/probe-upstream-release.ts`，用 Node 24 的类型剥离直接运行——不安装任何依赖。探测流程：

1. 解析上游 tag：`GET /repos/deepseek-ai/deepseek-harness/releases/latest`，或手动触发时操作者提供的 tag。`/releases/latest` 从不返回草稿或预发布版本。
2. 读取该 tag 下的 `apps/cli/package.json` 获取 npm 版本号（文件不可用时回退为 tag 后缀）。
3. 得出三种决策之一：
   - `skip` —— `@prettier-ai/dsh@<version>` 已存在于 npm registry，重活作业不运行。
   - `publish-only` —— 本仓库的跟踪 tag `prettier-ai/<version>` 已存在但 npm 缺少该版本（例如上一次运行完成打包但未能发布）。重活作业端到端重跑；发布按包幂等。
   - `sync` —— 全新版本。重活作业运行，结束后推送跟踪 tag。

重活的 `sync` 作业拉取官方 tag（浅克隆），把 overlay 脚本复制到该检出上，在其中运行 `--apply` 与 `--check --applied`，安装改写后的 workspace，构建，先打包 `vendor` 家族再打包 `dsh` 家族，将 tarball 上传为 workflow 产物，然后发布。

## 发布内容

- `@prettier-ai/dsh` —— CLI，保留上游的 `dsh` bin。
- `@prettier-ai/*` —— 官方发布中的各 workspace 包（core、vendor 与 landlock 家族），版本均与上游一致。

改写覆盖包清单、随包发布的源码 specifier、lockfile、发布脚本以及与打包相关的 CI。它刻意不动 Markdown 正文、GitHub URL、产品名称、`description` 字段和上游 `LICENSE`，因此 tarball 内保留带 DeepSeek 版权声明的原始 MIT 文本。

## 运维

### 必需的 secret

`NPM_TOKEN` —— 具有 `prettier-ai` org 发布权限的 npm token。在 Settings → Secrets and variables → Actions 中添加。缺失时 workflow 仍会改写、打包并上传 tarball 产物，然后以清晰的日志跳过 `npm publish`。

### 手动触发

在 Actions 页（或用 `gh workflow run`）运行 `Sync upstream release` workflow。可选的 `tag` 输入直接指定上游 git tag。预发布版本必须走这条路：`/releases/latest` 会跳过它们，只有操作者显式传入 tag 时才会发布 alpha 或 beta。

### 跟踪引用

`sync` 成功后会向本仓库推送轻量 tag `prettier-ai/<version>`。该 tag 标记版本已处理，使定时运行回到轻量的跳过路径；它指向本仓库的提交，绝不指向上游源码。

## 开发

```sh
pnpm install
pnpm run typecheck
pnpm test
```

单元测试不访问网络：探测脚本的 GitHub、npm 与 git 读取器均为注入实现，改写脚本的测试在临时 fixture 目录上进行。

## 许可证

本仓库自身文件采用 MIT 许可（© 2026 prettier-ai / aaravarr），见 [LICENSE](./LICENSE)。发布的 tarball 构建自官方 DeepSeek Harness 源码树，保留其 MIT 许可证与 DeepSeek 版权声明。
