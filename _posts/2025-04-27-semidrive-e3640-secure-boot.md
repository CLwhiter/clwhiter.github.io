---
title: "芯驰 E3640 安全启动剖析"
date: 2025-04-27 09:00:00 +0800
categories: [汽车电子]
tags: [AUTOSAR, MCU, SecureBoot]
image:
  path: /assets/img/e3640/secure-boot-cover.svg
  alt: 芯驰 E3640 安全启动
toc: true
comments: true
---

## 0 前情回顾

原理篇 [《MCU 安全启动流程分析》](/posts/secure-boot-analysis/) 讲了通用框架：链式逐级启动、RSA 非对称验签、OTP 硬件可信根。本文落到芯驰 E3640（E3 系列）的具体实现——芯驰将 OTP 称为 eFuse（电子熔丝），下文统一用 eFuse。本文覆盖 Boot Package 的结构、bootloader 的五步校验、eFuse 信任根的寄存器定义，以及一个验签格式的坑。

文中的寄存器与字段经过实际配置验证，代码逻辑以伪代码表达。

## 1 威胁模型与信任根设计

下文将持有私钥、对镜像签名的一方称为签名方。

车规 MCU 面对的是物理可达的攻击者：拆机、开放调试口、直接改写存储介质都是可操作的路径。E3640 比较特殊——它没有内置 Flash，APP 镜像放在外置 QSPI Flash 中（后续 E3650 改用内置 Flash），镜像本身完全暴露在芯片外部，攻击者可以直接用编程器读写。E3640 支持加密启动，可将 Flash 中的镜像以密文存储，本文只讨论安全启动（验签），加密启动不在此展开。对 APP 镜像而言，典型威胁三类：

1. 篡改业务逻辑后重新烧写；
2. 整体替换为自编译镜像；
3. 把攻击者自己的公钥写进 Boot 区，让私签镜像也能过验签。

安全启动要保证四件事：

| 性质 | 含义 | 对抗的威胁 |
|------|------|-----------|
| 完整性 Integrity | 镜像每个字节未被改动 | 篡改业务逻辑 |
| 真实性 Authenticity | 镜像由签名方私钥签名 | 整体替换镜像 |
| 不可否认 Non-repudiation | 签名方无法抵赖签名归属 | 抵赖归属 |
| 硬件可信根绑定 | 验签公钥的锚固化在芯片内 | 偷换公钥 |

前三件靠密码学，原理篇已推导。第四件是关键：bootloader 凭什么相信 Flash 里的公钥是签名方的？E3640 把公钥的 SHA256 哈希烧在 eFuse（即 OTP，芯驰对一次性可编程存储的称呼，见 §0）中作为信任锚，设备启动时比对这份哈希。三个具体设计选择：

- 公钥算法以下以 RSA2048 为例（当前使用的算法），`pubk_type` 字段支持 RSA512–4096 及 ECDSA P-256/384/521（见 §3.3）；
- 公钥本体放在 Boot Package 的 RCP 区（Root Certification Pack，根证书包），随镜像分发；
- 公钥所在 RCP 区的 SHA256 哈希（ROTPK，Root of Trust Public Key）烧写在 eFuse 中，设备启动时比对这份哈希。

![信任链全景：bootROM → bootloader → APP 三级链，eFuse 作为信任锚](/assets/img/e3640/trust-chain-overview.svg)

## 2 Boot Package：镜像在 Flash 上的组织

E3640 上电后，bootROM 根据 boot pin（启动模式选择引脚）的采样结果，从 XSPI / eMMC / SD / UART / USB 等介质获取下级启动镜像，镜像格式必须满足 Boot Package 规范：

> Boot Package = BPT（Boot Package Table，引导包表，固定 0x1000 字节）+ 镜像数据（紧跟 BPT 之后）

BPT 是固定 0x1000 字节的元数据表——固定大小让 bootROM 能用固定偏移解析，不需要额外的长度字段。镜像哈希、验签公钥、签名、CRC 等校验所需的字段都在表中。APP 的 Boot Package 放在 QSPI Flash 的一个基地址，下文记作 `APP_BASE`（取值 `0x10140000`，由产品分区布局决定，不是芯片固定值）：BPT 占据 `APP_BASE`–`APP_BASE+0xFFF` 共 4 KB，镜像数据从 `APP_BASE+0x1000` 开始，长度由 BPT 中的 `img_sz` 字段给出。

![Boot Package 在 Flash 上的布局及 BPT 内部结构](/assets/img/e3640/boot-package-bpt-layout.svg)

## 3 BPT 结构

BPT 共 0x1000 字节，按偏移分成五段：头部（0x000–0x01F）、IIB 区（0x020–0x3FF）、RCP 区（0x400–0x813）、签名区（0x814–0xA13）、尾部（0xA14–0xFFF）。

IIB（Image Information Block，镜像信息块）区共 8 个槽位，每个 124 字节，多核镜像每个核占一个槽。下文只列安全启动校验流程中实际读取的字段，未使用的预留字段不展开。

### 3.1 头部

| 字段 | 偏移 | 大小 | 含义 |
|------|------|------|------|
| `tag` | 0x00 | 4 | 魔数 `0x42505402`，小端存储字节序为 `02 54 50 42` |
| `sz` | 0x06 | 2 | BPT 总长，固定 `0x1000` |

### 3.2 IIB 区（第一个槽，偏移相对 IIB 起始 0x020）

| 字段 | 偏移 | 大小 | 含义 |
|------|------|------|------|
| `img_sz` | 0x48 | 4 | 镜像大小，Step 2 计算哈希时的长度 |
| `hash` | 0x5C | 64 | 镜像 SHA256 哈希，实占 32 字节，槽位按 64 预留 |

### 3.3 RCP 区（偏移相对 BPT 起始 0x400）

| 字段 | 偏移 | 大小 | 含义 |
|------|------|------|------|
| `pubk_type` | 0x405 | 1 | 公钥类型编码：2-RSA512、3-RSA1024、4-RSA2048（当前使用）、5-RSA3072、6-RSA4096、18/19/20-ECDSA P-256/P-384/P-521 |
| `pubk` | 0x410 | 1028 | `sign_len`（4B）+ `key1`（512B，模数 n）+ `key2`（512B，公钥指数 e）。两个 512 字节槽位按 RSA4096 预留，RSA2048 时各只用前 256 字节 |

### 3.4 签名区与尾部

| 字段 | 偏移 | 大小 | 含义 |
|------|------|------|------|
| `sig` | 0x814 | 512 | 签名方私钥对 BPT[0x000–0x813] 的哈希签名 |
| `crc32` | 0xFEC | 4 | BPT[0x000–0xFEB] 的 CRC32 校验值 |

两点结构信息：

- `sig` 是 BPT 的顶层字段，与 IIB 区、RCP 区同级，不嵌在 RCP 里。原因是签名必须覆盖 RCP 本身——如果公钥被替换后用攻击者私钥重签，sig 覆盖 RCP 就能检测到这种替换；如果 sig 嵌在 RCP 里，就无法覆盖 RCP 之外的字段。它覆盖自己之前的全部内容（头部 + IIB + RCP），这是签名与数据绑定的结构基础。
- `crc32` 覆盖 BPT[0x000–0xFEB]，不包含它自己和之后的字段。

## 4 bootloader 校验 APP：五步串行校验

先把两个视角分开：

- **bootROM 验 bootloader**：ROM 侧的校验流程是 4 步——①算 BPT 中公钥的 SHA256，与 eFuse 中 ROTPK1 对比；②用 BPT 公钥验证 BPT 签名；③计算每个核镜像哈希，与 IIB 中的 `hash` 对比；④全部通过则启动。ROM 固化在片内，不可改写。
- **bootloader 验 APP**：bootloader 侧实现了同机制的校验，并增加头部 CRC 快速失败和生命周期检查，共五步，任何一步失败立即返回、不跳转。

### 4.1 分层校验的设计逻辑

五道关各自堵一个不同层级的漏洞，且成本递增：

- Step 1 CRC 最便宜，先把 Flash 偶发位翻转/烧写错误挡在密码学运算之前；
- Step 2 镜像哈希保证完整性，任何字节改动都会让哈希对不上；
- Step 3 公钥哈希比对 eFuse 防偷换公钥，即便攻击者在 Flash 写了自己的公钥，eFuse 里的哈希对不上就直接拒；
- Step 4 RSA 验签证明真实性，签名只能由持有私钥的签名方产生；
- Step 5 整体 BPT 哈希收口签名覆盖范围，证明签名方签的就是眼前这份 BPT。

### 4.2 校验流程

以下以 RSA2048 为例（E3640 支持多种密钥类型，见 §3.3），字段名即 §3 表中的 BPT 字段：

```text
verify_app_image():
    fuse_init_for_dev()    # 仅开发期，量产删除
    crypto_init()

    # 1. CRC 快速失败
    if CRC32(BPT[0x000:0xFEC]) != BPT.crc32: return FAIL

    # 2. 镜像完整性（失败时尝试备份镜像）
    if SHA256(image, BPT.iib.img_sz) != BPT.iib.hash: return FAIL

    # 生命周期检查（非信任校验，见 §5）
    if eFuse.PROD.bit7 != 1: return FAIL

    # 3. 可信根绑定
    if SHA256(BPT.rcp) != eFuse.ROTPK1: return FAIL

    # 4. RSA 公钥运算
    EM = RSA_public(BPT.sig, BPT.rcp.pubk.e, BPT.rcp.pubk.n)

    # 5. 签名覆盖范围（无 DigestInfo 前缀，见 §6）
    if EMSA_decode(EM) != SHA256(BPT[0x000:0x814]): return FAIL

    return PASS
```

![五步串行校验的执行顺序、读取的字段与失败分支](/assets/img/e3640/verify-flow.svg)

夹在 Step 2 和 Step 3 之间的生命周期检查是模式判断（芯片是否进入量产生命周期），不是信任校验，所以不计入五步。

两道哈希比对的语义差别：Step 2 比对的是 IIB 里随镜像分发的哈希（防镜像被改）；Step 3 比对的是 eFuse 里的哈希（防公钥被换，硬件信任根）。Step 5 把签名与 BPT 数据绑定：证明私钥签的就是眼前这份 BPT。

校验全部通过后，bootloader 对目标核（以 SF 核为例）做强制地址重映射——上电后核的取指地址固定在启动区，校验通过后把取指窗口重映射到镜像所在位置（`APP_BASE+0x1000`），随后跳转。任一步失败则停在死循环或进入更新模式，两种结局都不会执行不可信镜像。

## 5 信任根：eFuse 与生命周期

Step 3 比对的 ROTPK1 存在 eFuse 的 OTP（One-Time-Programmable，一次性可编程）单元里，物理特性是烧写后固化、不可改写、不可擦除。信任根必须存放在这种不可改写的介质中——Flash 可被攻击者改写，只有 OTP 的一次性写入特性能保证公钥哈希一旦烧入就无法替换。eFuse 控制器（EFUSEC）提供寄存器级访问接口：

| 寄存器 | 偏移 | 宽度 | 含义 |
|--------|------|------|------|
| `ROTPK1` | `EFUSEC + 0x10A0` | 8 × 32bit | 签名方公钥哈希（SHA256，32 字节） |
| `PROD` | `EFUSEC + 0x12C0` | 8bit | 量产生命周期标志，bit7 置 1 表示量产 |

eFuse 通常在量产阶段烧写——OTP 一次性写入，烧早了开发调试就没有回退余地。

### 5.1 开发期伪值

开发期芯片的 eFuse 是空的：ROTPK1 没烧写，生命周期位也没置位，Step 3 和生命周期检查都过不去。开发阶段的做法是向 eFuse 控制器的影子寄存器写伪值，临时模拟已烧写的数据——之所以不直接烧 OTP，是因为 OTP 一次性写入不可逆，开发阶段需要反复调试不同的密钥和配置：

```text
fuse_init_for_dev():                    # 仅开发期，量产删除
    eFuse.PROD           ← 0x80         # 量产生命周期标志
    eFuse.ROTPK1[0..7]   ← H_test       # 测试公钥的 SHA256，8 个 32bit 字
```

写入的 `H_test` 是测试密钥对（TestRSA2048）公钥的 SHA256，分 8 个 32 位寄存器写入，与读回侧的 8 次寄存器读取一一对应。

这段初始化代码在量产版本中必须删除。影子寄存器与 OTP 单元的区别：

| | 影子寄存器（开发期写伪值） | OTP 单元（量产烧写） |
|---|---|---|
| 易失性 | 易失，复位即失效 | 非易失，永久保持 |
| 可写性 | 软件可写，可反复改 | 一次性，写后不可逆 |
| 安全属性 | 只是开发便利，不是可信根 | 物理固化，才是真可信根 |

![开发期伪值与量产 OTP 烧写的两条路径](/assets/img/e3640/efuse-lifecycle.svg)

## 6 实战坑：裸 PKCS#1 v1.5 签名（无 DigestInfo 前缀）

Step 4/5 的验签格式有一个与标准库不兼容的点——E3640 使用的是裸 PKCS#1 v1.5 签名（raw PKCS#1 v1.5 signature），即 EMSA 编码中省略了 DER DigestInfo 前缀。做本地签名/验签复核时，我在这个点上踩了坑。

按 RFC 8017，PKCS#1 v1.5 签名的编码消息 EM（Encoded Message，编码消息）里，哈希前面有一层 DER 编码的 `DigestInfo`（声明摘要算法类型）。裸签名省略了这层前缀，EMSA 填充后直接就是 32 字节原始 SHA256：

```text
RFC 8017 标准:  EM = 00 01 FF…FF 00 ‖ DigestInfo(DER, 19B) ‖ SHA256(32B)
E3640:          EM = 00 01 FF…FF 00 ‖ SHA256(32B)
```

解码逻辑也印证了这一点——只做结构剥离，不解析 DigestInfo，把分隔字节 `0x00` 之后的全部内容整体当作哈希：

```text
EMSA_decode(EM, k):                     # k = 256，即 RSA2048 模长
    i ← 2
    while EM[i] ≠ 0x00: i ← i + 1       # 扫过 FF 填充，定位分隔字节
    mLen  ← k − i − 1
    PSLen ← k − 3 − mLen
    if EM[0] ≠ 0x00 or EM[1] ≠ 0x01 or PSLen < 8:
        return FAIL                     # 填充结构合法性检查
    return EM[k − mLen .. k]            # 尾部 mLen 字节即哈希，无 DER 解析
```

我当时在做本地"私钥签名 → 公钥验签"的复核工具，直接用 Python 的 `Crypto.Signature.pkcs1_15` 验签，怎么验都失败——库按标准格式在负载里找 DER `DigestInfo`，找不到，判定签名非法。解法是手写裸签名的 EMSA 解码：对 `sig` 做原始 RSA2048 公钥运算得到 EM，跳过 `00 01` 与 `FF…FF` 填充、跨过 `0x00` 分隔字节，把剩余 32 字节与本地重算的 `SHA256(BPT[0x000–0x813])` 直接比对，相等即通过。

![EM 字节结构：裸 PKCS#1 v1.5 签名与 RFC 8017 标准格式对比](/assets/img/e3640/emsa-em-layout.svg)

如果用标准密码库对接 E3640 验签，记住一点：不要用封装好的 pkcs1_15 验签接口，用底层原始 RSA 运算 + 手动比对哈希。

## 7 小结

E3640 安全启动的完整链路：ROM 按 boot pin 取 Boot Package（BPT + 镜像），bootROM 与 bootloader 逐级做"公钥哈希比对 eFuse → RSA 验签 → 镜像哈希"校验；信任根是 eFuse 中一次性烧写的 ROTPK1（`EFUSEC+0x10A0`，32 字节 SHA256），生命周期由 `EFUSEC+0x12C0` 的 PROD 位把关；开发期向影子寄存器写伪值跑通流程，量产删除伪值、烧写真值。对接验签工具时注意 E3640 使用裸 PKCS#1 v1.5 签名（无 DigestInfo 前缀），标准库默认实现验不过，需手写解码后比对哈希。

## 附：术语速查

| 术语 | 全称 | 含义 |
|------|------|------|
| Boot Package | — | 可启动镜像的组织形式：BPT（0x1000 字节）+ 镜像数据 |
| BPT | Boot Package Table | Boot Package 的元数据表，哈希/公钥/签名/CRC 都在表中 |
| IIB | Image Information Block | 镜像信息块，BPT 内共 8 个槽，每个对应一个核镜像 |
| RCP | Root Certification Pack | 根证书包，存放验签公钥及其属性 |
| ROTPK | Root of Trust Public Key | RCP 的 SHA256 哈希，烧写在 eFuse 中，是信任锚 |
| eFuse | — | 电子熔丝，一次性可编程单元 |
| OTP | One-Time-Programmable | 一次性可编程，烧写后固化、不可改写 |
| EFUSEC | eFuse Controller | eFuse 控制器，提供影子寄存器（开发期可写）与 OTP 读回 |
| PROD | Production | 量产生命周期标志，bit7=1 表示量产 |
| EM | Encoded Message | 签名经 RSA 公钥运算后的编码消息 |
| EMSA-PKCS1-v1_5 | RFC 8017 | RSA 签名的填充编码格式 |
| DER | Distinguished Encoding Rules | 标准格式中声明哈希算法的编码前缀；裸签名省略此前缀 |
| 裸 PKCS#1 v1.5 签名 | raw PKCS#1 v1.5 signature | EMSA 编码中省略 DER DigestInfo 前缀，直接填充原始哈希 |
| 魔数 | magic number | 识别数据结构开头的固定标识值 |
