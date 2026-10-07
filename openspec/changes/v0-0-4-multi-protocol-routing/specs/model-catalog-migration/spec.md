# Model Catalog Migration

## Purpose

安全升级已落盘的内置模型协议目录，使旧 Claude 与 OpenAI 配置能使用本版原生适配器，同时保留用户密钥、自建网关、默认引用和预算覆盖，避免加载合并结果被整份写回造成配置膨胀或目录与运行时长期不一致。

## ADDED Requirements

### Requirement: Builtin protocol migration is versioned
内置 Claude SHALL 迁移为 anthropic，内置 OpenAI SHALL 迁移为 openai-responses，并提升目录版本。升级 SHALL 保留 API Key、默认模型/角色引用和 ID；自建 Profile 的显式协议 SHALL 不被厂商推断覆盖。

#### Scenario: Existing builtin OpenAI profile has an inline key
- **WHEN** 旧目录升级
- **THEN** 协议改为 Responses，原密钥和默认/角色引用保留

#### Scenario: Custom gateway uses a Claude name
- **WHEN** 自建 Profile 经过目录升级
- **THEN** 其 Chat 协议和端点保持用户值

### Requirement: User output overrides survive catalog upgrades
已存合法 maxOutputTokens SHALL 作为用户覆盖保留；缺省 SHALL 从内置目录继承默认。升级 SHALL 不将未启用内置 Profile 物化进全局用户文件，不新增无删除理由的 ID 重定向。

#### Scenario: User configured a lower output ceiling
- **WHEN** 内置原生模型升级目录
- **THEN** 用户更低预算保持有效，其它未启用 Profile 不写入文件

### Requirement: Configuration persistence precedes activation
配置写入 SHALL 基于原始全局用户设置；损坏或非法文件 SHALL 中止写入。角色绑定或目录升级写入失败 SHALL 保留原文件和有效内存状态，不泄漏凭据。

#### Scenario: Role mapping cannot be persisted
- **WHEN** 用户保存 planning 绑定发生写入错误
- **THEN** 报失败，不假称磁盘成功，也不激活未保存映射

#### Scenario: Caller saves the migrated settings object again
- **WHEN** 同一设置对象在目录迁移成功后再次保存
- **THEN** 内存中的 profiles、默认/角色引用及目录版本均与首次保存结果一致，不以新版本号重新写入旧协议
