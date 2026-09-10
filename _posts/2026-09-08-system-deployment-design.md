---
title: "从独立域控到中央计算：软件部署演进"
date: 2026-09-08 09:00:00 +0800
categories: [汽车电子]
tags: [EEA, Hypervisor, S32N7, RTOS, 中央计算]
image:
  path: /assets/img/deployment-design/cover.svg
  alt: 从独立域控到中央计算：软件部署演进
mermaid: false
toc: true
comments: true
---

## 1 引言——软件为什么从分布式走向集中式

系统部署是嵌入式软件设计的核心问题之一：一颗芯片上跑什么 OS、几个 OS 之间怎么隔离、核与核之间怎么通信——这些决策直接决定了软件架构的形态，也决定了后续迭代的成本和天花板。

汽车软件的部署方式在过去十几年里发生了根本性变化。传统燃油车是分布式 ECU 架构——一个功能一个盒子，整车动辄上百个 ECU，每个 ECU 由不同供应商提供，软硬件深度耦合。这种架构在机械为主的时代没问题，但到了电动化和智能化时代就撑不住了：上百个 ECU 意味着上百个供应商、上百套软件版本、上百条线束，整车级 OTA 几乎推不动，跨域数据融合要绕好几道总线。

特斯拉是第一个在量产车上大胆做减法的。2012 年 Model S 率先大规模精简整车 ECU；2017 年上市的 Model 3 走得更远：中央计算模块（CCM）里物理合装了两块计算单元——座舱的媒体控制单元（MCU）和智驾的自动驾驶计算机（ADC），车身 IO 则收敛到前、左、右三个车身控制器（BCF / BCM-LH / BCM-RH），整车 ECU 数量只有同级分布式车型的一半左右，被行业普遍认为是集中式 E/E 架构的引领者<sup>[1](#ref-1)</sup>。下图是 2019 款 Model 3 的 E/E 架构<sup>[2](#ref-2)</sup>——座舱（MCU）与智驾（ADC）同盒合装、车身 IO 三个控制器分担、多路 CAN 骨干通信，集中化的形态一目了然：

![特斯拉 Model 3 E/E 架构（2019 款）](/assets/img/deployment-design/tesla-model3-eea.png)

这个变化的底层驱动力是电动化：电动车没有发动机、变速箱那一堆动力总成 ECU，三电系统本身就是集中控制的，电平台也给了整车电气架构重新设计的空间。再加上软件定义汽车的诉求——要整车级 OTA、要跨域数据融合、要持续迭代功能——分布式架构天然做不到，集中式是唯一出路。

如果把视线拉长，会发现这个集中化过程有三条主线在同时推进：

1. **芯片数量在减少**：从多 ECU 到域控制器，从域控制器到舱驾一体，再到中央计算——越来越多的功能被收进更少的芯片里。
2. **隔离方式在变软**：从物理分离（两颗芯片）到硬件隔离（XRDC、TrustZone）再到虚拟化隔离（Hypervisor）——隔离的粒度越来越细，灵活性越来越高。
3. **数据延迟在下降**：从跨芯片毫秒级到跨核微秒级再到片内亚微秒级——感知决策到执行的闭环越来越短。

这三条主线交汇的终点，就是中央计算：让应用处理和实时控制以更高的密度共存，用硬件隔离加虚拟化保证安全，用片内互联保证低延迟。

这条演进路线业界已有成熟共识，也就是经典的博世演进模型：从分布式 EE 架构的模块化、功能集成化，到域集中式的功能域控化、域融合化，再到中央集中式 EE 架构的中央集中化，最终走向中央集中+信息化的车路云网一体化协同：

![汽车 EEA 发展路线：分布式 → 域集中 → 中央集中式（经典博世演进模型）](/assets/img/deployment-design/eea-evolution-roadmap.png)

对应关系正好是：功能域控化就是本文的阶段一（独立域控），域融合化对应阶段二（舱驾一体），中央集中化及其后的信息化演进对应阶段三（中央计算）。

这篇文章以座舱和智驾两个域的演进为线索——它们是对算力和交互需求增长最快、部署方式变化最剧烈的两个域——来看**独立域控 → 舱驾一体 → 中央计算**三个阶段的软件部署方案。需要说明的是，整车当然不止这两个域，底盘、动力、车身这些域也在走同样的集中化路线，阶段三会一并纳入车辆核心的视野。

文章的后半部分以 NXP S32N79 这款真实芯片为样本，推演车辆核心芯片的软件部署方案。这里用到了"大脑"和"小脑"的说法——这不是汽车行业的传统术语，而是随着物理 AI（Physical AI）和具身智能的探索，人们开始用"大脑负责感知决策、小脑负责实时运动控制"的视角来理解智能体的计算架构。汽车本质上也是一个在物理世界中感知、决策、执行的智能体，用这个视角来看中央计算芯片的核群分工，比单纯说"应用核"和"实时核"更直观。这个视角也预告了本文的叙事线：阶段一、二其实是"大脑"侧的故事——座舱与智驾从各自域控走向合体；阶段三轮到"小脑"——把散落全车的硬实时控制集中到一颗芯片上。两条线在中央计算平台会师，缺一不可。

## 2 阶段一：域集中——独立的座舱与智驾域控制器

电动化和智能化把整车的算力需求推向两个极点：座舱要交互和生态，智驾要感知和规控。第一阶段的答案是**域集中**——按功能划分域，每个功能域一个高算力控制器：座舱域、智驾域、动力域、底盘域、车身域，域与域之间通过网关互联。其中变化最大、也最能代表这一阶段部署思路的，是座舱和智驾两个域。

**座舱域**的经典分工是一颗高性能 SoC 配一颗 MCU：SoC（高通 8155/8295、芯驰 X9 等）跑 Android 或 Linux，负责仪表、中控、娱乐、语音交互；MCU（S32K、TC3xx 等）跑 RTOS/AUTOSAR CP，负责 CAN/LIN 报文收发、休眠唤醒、车身控制指令下发、SoC 健康监控。这种部署的逻辑很朴素：**应用和实时天生是两个世界**。SoC 的大核（Cortex-A）有 MMU、能跑复杂 OS，但中断延迟和调度确定性没法保证；MCU 的小核（Cortex-M/R）实时性好、启动快，但算力有限，跑不动 Android。两者通过 SPI/UART/CAN 交换数据，各司其职。

**智驾域**则是另一套打法：一颗大算力 AI SoC（英伟达 Orin-X、地平线征程 5 等）扛下摄像头、雷达、激光雷达的数据接入，跑感知、融合、规控全栈，OS 多为 Linux 或 QNX。因为直接面对行驶安全，安全关键的职责（安全监控、部分规控）会放到片内的安全岛或锁步核上，与开放环境的感知部分隔离。智驾域一般不配独立 MCU——它的控制输出经 CAN 直接交给底盘、动力域的控制器执行。

![阶段一：域集中——独立的座舱域与智驾域控制器](/assets/img/deployment-design/stage1-domain-control.svg)

域集中的优点是边界清晰：每个域独立开发、独立 OTA，安全隔离靠物理分离保证。缺点也明显：每域一套 BOM、一套电源，跨域数据交换走以太网/CAN，延迟毫秒级；座舱域的 MCU 算力往往成为车控功能扩展的瓶颈，而智驾与座舱之间的高带宽共享（比如感知结果上屏）更是要绕经网关。

**域集中的部署本质是"分而治之"：域内部解决应用与实时的矛盾（物理分离或核分工），域与域之间用网关解耦**。当两个域的算力需求和数据交互都涨到一定程度，把域重新合起来的动力就出现了——这就是阶段二。

## 3 阶段二：舱驾一体控制器——One Chip 上的多 Guest OS

舱驾融合把座舱和智驾收进同一颗大 SoC。这个演进不是一蹴而就的，行业实际经历了三种集成形态<sup>[3](#ref-3)</sup>：

| 形态 | 说明 | 代表方案 | 状态 |
|------|------|---------|------|
| Multi Board（多板多芯） | 座舱/智驾各一块板，以太网互联 | 蔚来 ADAM（4×Orin-X + 8155） | 已量产 |
| One Board（单板多芯） | 一块 PCB 上放座舱+智驾 SoC，高速互联 | 亿咖通 Super Brain（龍鹰一号 + 黑芝麻 A1000） | 已发布 |
| One Chip（单芯片） | 单颗 SoC 同时跑座舱+智驾 | 高通 8775（极狐阿尔法 T5 首搭）/ 英伟达 Thor | 2025 起量产 |

One Chip 是舱驾一体集成度最高的形态，也是部署设计最有代表性的形态。这颗 SoC 的 A 核足够多，于是在上面跑一个 Type-1 Hypervisor（直接运行在硬件 EL2 层<sup>[4](#ref-4)</sup>，不依赖宿主 OS，车载方案如 QNX Hypervisor、Green Hills Multivisor 均属此类<sup>[5](#ref-5)</sup>），虚拟出多个 Guest OS。以高通 8775 为例，典型的三 Guest 分工是：

| Guest OS | 功能安全等级 | 实时性 | 职责 |
|----------|-------------|--------|------|
| **Android** | QM | 非实时 | 座舱娱乐/交互：导航、音乐、语音、应用商店 |
| **QNX** | ASIL-D | 硬实时（<1ms） | 仪表渲染、车控、安全网关、OTA 安全校验 |
| **Linux** | ASIL-B（可选） | 软实时（<10ms） | 智驾感知/规划/控制：摄像头 ISP、障碍物检测、路径规划 |

![阶段二：舱驾一体控制器部署架构](/assets/img/deployment-design/stage2-cockpit-driving.svg)

Hypervisor 在这个架构里做三件事：**vCPU 绑核**（QNX 绑定安全核，Android 绑定性能核）、**内存配额硬隔离**（各 VM 内存上限固定，防止 OOM 互影响）、**I/O 直通或虚拟化**（安全关键外设直通 QNX，非安全设备走 VIRTIO）。安全隔离是三道防线：硬件隔离（TrustZone、SMMU）→ Hypervisor 隔离（vCPU 绑核、内存配额、Watchdog）→ OS 内部隔离（QNX 微内核、Android SELinux、Linux seccomp）。

虚拟化解决的只是"装得下"，舱驾一体的真正收益在软件层：

1. **算力动态调度**：行车时算力向智驾倾斜，泊车和充电时向座舱娱乐、大模型倾斜——Hypervisor 统一调度下，NPU 和 CPU 算力按场景动态分配，不用各域固守静态配额。
2. **数据低延迟共享**：感知结果直接驱动 AR-HUD、智驾摄像头视频流无损上座舱屏，这类跨域功能在同一颗芯片内走内存，延迟和带宽都不再是瓶颈。
3. **统一软件栈**：一套 Hypervisor、一套中间件、一条 OTA 通道覆盖两个域，AUTOSAR AP 这类跨域中间件有了落点。

但这里有一个关键的工程事实：**当前绝大多数量产舱驾一体方案，SoC 外面仍然挂着一颗独立 MCU**（S32G、TC3xx 等）。这颗 MCU 跑完整的 AUTOSAR CP，承担整车 CAN 网关、底层执行闭环、E2E 保护、休眠唤醒，同时独立监控 SoC 健康状态——SoC 异常时它能独立触发安全降级。

不把 MCU 也干掉，原因很直接：A 核的缓存、中断、调度抖动都是硬伤，AUTOSAR CP 的整车车控对确定性和功能安全的要求，目前在 A 核上很难完整满足。高阶智驾目前很少用"单芯片无外置 MCU"的方案，这是工程现实。

以一颗搭载舱驾一体 SoC（如高通 SA8775P）加独立 MCU 的量产车型为例，功能在各个处理单元上的分布大致是：

| 功能模块 | 处理类型 | 负责组件 | 运行系统 / 软件 |
|--------|---------|--------|--------------|
| 高速 NOA 领航辅助 | 实时处理 | SoC 智驾 VM | QNX / Linux RT + 感知规控 |
| DMS 驾驶员监控 | 实时处理 | SoC 安全岛 / 协处理器 | 专用实时 OS + 视觉算法 |
| AR-HUD 显示 | 应用处理 | SoC 座舱 VM | Android + 3D 渲染 |
| 语音助手 | 应用处理 | SoC 座舱 VM | Android + 大模型推理 |
| 车窗 / 空调控制 | 实时处理 | 独立 MCU | AUTOSAR CP |
| 智能配电 | 实时处理 | ZCU 内 MCU | 实时 OS + eFuse 控制 |
| OTA 升级管理 | 应用处理 | SoC 座舱 VM | Android + OTA 客户端 |

这张表的分界线就是"实时处理 vs 应用处理"：安全关键、确定性优先的功能全部在 RTOS 侧，体验和生态优先的功能才交给 Rich OS。这条分界线会一路贯穿到中央计算阶段。

所以阶段二的部署特征是：**应用层全面虚拟化，实时层仍然物理分离**。Hypervisor 解决了"多个大 OS 怎么共存"的问题，但"大 OS 和硬实时控制怎么共存"的问题，还没解决。

## 4 阶段三：中央计算的软件部署设计

到了中央计算阶段，核心挑战变成了：**怎么在一个高度集中的计算平台上同时承载大脑的应用负载和小脑的实时控制，并且让实时侧内部也能做域间隔离。**

单芯片集成这件事，机器人行业已经给出了先例：在一颗异构 SoC 上同时跑 Linux 和 RTOS，不用 Hypervisor，靠核的异构性做天然隔离。典型的例子是瑞芯微 RK3588 的 AMP 双系统方案<sup>[6](#ref-6)</sup>——4× Cortex-A76 大核（最高 2.4 GHz）分给 Linux，跑视觉 SLAM、AI 识别、ROS 2；4× Cortex-A55 小核（最高 1.8 GHz）分给 RTOS，跑运动控制、EtherCAT 主站，核间用片内共享内存加 rpmsg 通信。自平衡小车、机械臂里也能看到类似的"一芯多 OS"思路<sup>[7](#ref-7)</sup>。

![异构单芯片部署架构（RK3588 等）](/assets/img/deployment-design/heterogeneous-soc.svg)

它的本质是**用核的异构性代替芯片的物理分离**：A76 和 A55 针对不同负载优化，不需要 Hypervisor 做"模拟隔离"，核间通信走片内共享内存，延迟微秒级。但天花板同样清楚：A55 是应用级能效核，不是 Cortex-R 那样的实时核——没有 TCM、WCET 分析精度有限，只能做到毫秒级周期的**软实时**；A 核也没有功能安全认证和硬件资源域隔离。所以这个先例证明了方向，也划出了边界——从软实时到硬实时、从无安全要求到 ASIL D，需要的是**有真正的 R 核群、有功能安全认证、有硬件资源域隔离**的芯片。

这个先例的终点——有真正的 R 核群、功能安全认证和硬件资源域隔离——正是阶段三的主角。我选 NXP S32N79 作为具体样本来展开设计——它的公开规格文档比较充分，A+R 异构核群的配置有代表性，除产品页和框图外，还有两份 NXP 技术日资料详细讲了 S32N 系列的隔离架构与整合场景<sup>[8](#ref-8)</sup><sup>[9](#ref-9)</sup>，拿来推演部署设计正合适。需要说明：下文是我个人基于公开资料的设计推演，不是 NXP 的官方参考设计，价值在部署设计的思路和方法本身，实际项目要按具体的功能安全目标和供应商方案调整。先把硬件底数摆清楚。

### 4.1 S32N 的定位与硬件资源

#### 定位：车辆核心，不跑座舱和高阶智驾

把这种车辆核心的部署问题抽象出来，它的架构特征高度一致：**应用核群 + 实时核群**（应用核跑 Rich OS 承载服务与协同，实时核跑 RTOS 承载确定性控制）、**大容量片上 SRAM + 硬件资源域隔离**（核间交换不走外部内存，隔离由总线级硬件保证）。这个架构特征也划定了它的能力边界——拿 S32N79 代入验证，"车辆核心不跑座舱和高阶智驾"的判断有三条硬理由：

1. **没有 GPU 和 ISP**。座舱 HMI 渲染依赖 GPU，摄像头接入依赖 ISP，这类芯片的 A 核集群里两样都没有——这是硬件层面的"不能"，不是软件层面的"不便"。
2. **NPU 是 TOPS 级的**。片上 NPU 面向轻量推理（DMS、边缘数据智能这类负载），高阶智驾的 BEV/Occupancy 感知需要百 TOPS 级专用算力，两者差着量级。
3. **生态绑定**。座舱和智驾的软件栈深度绑定专用 SoC 生态——Android Automotive / QNX 的应用生态、智驾算法与计算平台的联合优化，都在专用芯片上迭代最快；控制域软件（AUTOSAR CP/AP）反而是跨芯片可迁移的。

这个判断与 NXP 的官方口径一致：S32N 系列的定位是 super-integration 的**车辆核心**，与座舱/智驾 HPC 之间隔着一道硬安全边界<sup>[8](#ref-8)</sup>。NXP 官网给出的功能覆盖图，按照从实时处理到应用处理的顺序，列出了六类功能：

![S32N 系列功能覆盖图（NXP 官方）](/assets/img/deployment-design/s32n-vehicle-functions.svg)

对应的六类功能及部署归属如下：

| 功能域 | 典型内容 | 实时性 / 安全等级 | 跑在哪种核上 |
|--------|---------|------------------|-------------|
| Vehicle Propulsion and Dynamics | 底盘线控、制动转向、VCU 扭矩管理、电机控制、整车动力学 | 硬实时，ASIL D，微秒级闭环 | R52（锁步） |
| Body and Comfort Strategy | BCM 车身控制、灯光、门窗、座椅、空调策略 | 周期确定性，ASIL B/A | R52（Split） |
| Vehicle Mgmt. and General-Purpose | 整车状态机、电源管理、模式管理、故障管理、WdgM 监控、BIST、诊断调度 | 中实时，ASIL B | R52（Split） |
| Vehicle Gateway / Networking | 整车网关、报文路由、协议转换、防火墙 | 高吞吐 + 确定性，ASIL B | R52 + RCU 卸载 |
| ADAS Sensor Fusion and Functions | 多传感器融合；**控制意图校验、MRM 执行**（感知/规划在舱驾 SoC） | 融合与校验需硬实时 | R52（安全监控）+ 舱驾 SoC |
| Data and AI Services | 数据采集、AI 推理、车云协同、OTA | 非强实时，QM/ASIL B | A78AE + NPU |

这个映射关系是部署设计的起点，但有一处要按整车视角修正：NXP 把"ADAS Sensor Fusion and Functions"列为覆盖域，指的是**融合与安全监控**这类实时、安全职责，而不是感知本身——官方资料里，座舱 IVI 和 ADAS 感知被明确划在 S32N 之外的"智能手机域"，与车辆核心之间隔着一道硬安全边界<sup>[8](#ref-8)</sup>，感知需要的频繁硬件换代也被挡在外面。换句话说，这颗芯片的定位天然就是**车辆核心**：底盘、动力、车身、网关、整车管理这些实时与安全职责，加上车辆服务（OTA、数据、SDV 管理），而不是座舱和大算力感知。

#### 硬件资源底数

以下均为 NXP 官方公开规格<sup>[10](#ref-10)</sup><sup>[11](#ref-11)</sup>：

| 模块 | 配置 |
|------|------|
| 应用核 | 8× Cortex-A78AE，4 个双核集群，最高 1.8 GHz，支持 Split/Lock |
| 实时核 | 12× Cortex-R52，**3 个 RTU（每 RTU 含 2 个 Cluster，每 Cluster 2 核）**，最高 1.4 GHz，支持 Split/Lock |
| 片上 SRAM | 36 MB（带 ECC） |
| 外部内存 | 2× LPDDR5X（inline ECC） |
| 加速器 | CAR-V 通用加速器、eIQ Neutron NPU、RISC-V 网络/数学加速器、Central DMA（双引擎） |
| 安全 | XRDC 硬件资源隔离、HSE2 硬件安全引擎、最高 ASIL D |
| 通信 | NETC4 TSN 以太网交换机（7 个外部端口，10 Gbps–10 Mbps）、CAN Hub（CAN FD / CAN XL）、LIN、FlexRay、PCIe Gen4（SR-IOV） |
| 系统控制 | 2× Cortex-M7（系统管理 + 辅助）、Cortex-M0+ 管家岛、SMMU、FCCU/MBIST/LBIST |
| 通信卸载 | RCU 实时通信单元（内置独立 Cortex-R52 + TCM，专管 CAN/LIN/FlexRay 报文） |

NXP 官方的芯片框图如下<sup>[12](#ref-12)</sup>，可以直观看到三个 R52 实时处理集群、四个 A78AE 应用处理集群、以及内存、加速器、安全、通信各子系统的布局：

![S32N7 芯片框图（NXP 官方）](/assets/img/deployment-design/s32n7-block-diagram.png)

这颗芯片值得注意的设计点不是"核多"，而是**核群的配比和组织方式**：12 个 R52 不是点缀，是和 8 个 A78AE 对等的主力核群；36 MB 片上 SRAM 让核间数据交换不需要走外部 DDR；XRDC 在硬件层面做资源域隔离，不是纯软件方案。NXP 官方把它定位为"vehicle super-integration processor"，宣称最高可整合 8 个传统功能域<sup>[13](#ref-13)</sup>——这个数字是厂商口径，实际能整合多少取决于软件架构和功能安全分解。

顺带回应一个诱惑：官方宣称这类芯片最高可整合 8 个传统功能域，理论上把座舱和智驾也收进来是"集成上限"。但上面三条理由决定了这个上限形态只对成本极敏感或特定场景有意义；对主流平台，舱驾交给专用 One Chip SoC、车辆核心专注控制与服务，边界更干净，两颗芯片也各自保留独立的换代节奏。

把这套定位落成具体的软件部署，就是下一节的内容。

### 4.2 部署设计：Cohort 划分

#### 总体架构

中央计算的答案由两半拼成：大脑平台的舱驾融合继续由 One Chip SoC 承担；而散落全车的硬实时控制——动力、底盘、车身、网关——则集中到另一颗芯片上。**这本质上是传统硬实时控制软件策略的上移**：原来跑在几十个 MCU 里的确定性控制业务，连同诊断、网络管理、标定这些配套基础设施，整体搬迁到一颗带实时核群的芯片里统一治理。借用前文的说法，大脑平台集中了"大脑"，车辆核心集中了"小脑"。

于是中央计算平台的推荐形态是：

**一颗舱驾一体 SoC（大脑：延续阶段二的 One Chip 形态，承载座舱 + 智驾）+ 一颗车辆核心芯片（实时控制 + 车辆服务）+ 若干区域控制器（ZCU，就近 IO 与配电）**，通过 TSN 以太网骨干互联，两颗主芯片之间另有 PCIe Gen4 直连。

![中央计算平台部署总览：大脑（舱驾融合）与小脑（整车控制）](/assets/img/deployment-design/s32n7-overview.svg)

在这个形态里，车辆核心片内的部署以 **Cohort 为基本隔离单元**——每个 Cohort 是 XRDC 硬件强制隔离的资源域，可独立复位、独立下电，Cohort 之间默认互不干扰。R52 侧按功能域划分为四个业务 Cohort，A78AE 侧划分为两个服务 Cohort，加上系统基础 Cohort（Cohort 0），一共七个 Cohort。Hypervisor 不是必选项——资源充足时优先裸机运行，只有特定场景才引入（4.3 节展开）。下面按系统基础组、实时控制域、应用服务域三组分别展开。

#### Cohort 0：系统基础组

Cohort 0 是芯片的"中控室"，不跑任何整车业务应用。它运行 NXP 官方 FSS 固件，在上电时第一个启动，负责解析 PaCo 分区契约、配置 XRDC 硬件隔离、校验并启动各个业务 Cohort，同时管理全芯片的时钟、电源、复位和全局故障。

![Cohort 0 · SBC 系统基础组](/assets/img/deployment-design/s32n7-cohort0-sbc.svg)

Cohort 0 的资源是固定的：2 颗锁步 Cortex-M7、3 MB 专属 SRAM，以及 CLOCK、RESET、POWER、XRDC、FCCU、HSE2 等系统外设。它是整个芯片的信任根和管理面，任何业务 Cohort 都无法修改它的配置。

#### 实时控制域：Cohort 1 ~ 4（Cortex-R52）

12 颗 R52 分成三个 RTU，每个 RTU 含两个 Cluster（每 Cluster 2 核）。资源分配的原则是：**ASIL D 域独占完整 RTU，ASIL B 域共享 RTU**。R 核使用片上 SRAM 做指令和数据存储，不占用 LPDDR5X DRAM——DRAM 留给 A 核的 Linux 服务使用。

![实时控制域 · Cohort 1 ~ 4（Cortex-R52）](/assets/img/deployment-design/s32n7-cohort-r52-realtime.svg)

四个 Cohort 的功能覆盖：

- **Cohort 1 · 动力总成（ASIL D）**：独占 RTU 0，4 核全锁步，10 MB SRAM。跑电机控制、BMS 电池管理、OBC 车载充电、DC-DC 控制。外设包括 CAN、SPI、I2C、LIN、ADC/PWM。
- **Cohort 2 · 底盘与运动控制（ASIL D）**：独占 RTU 1，4 核全锁步，10 MB SRAM。Cluster 0 跑底盘控制（EPS 转向、ESC/ESP、线控制动、悬架、整车动力学 VDC），Cluster 1 跑 ADAS 安全监控（智驾控制意图校验、MRM 最小风险状态执行）。外设包括 CAN、SPI、SENT、PWM、定时器。
- **Cohort 3 · 车身与舒适（ASIL B）**：占 RTU 2 的 Cluster 0，2 核 Split 模式，5 MB SRAM。跑 BCM 车身控制、灯光/门窗/座椅、热管理/空调、泊车辅助、休眠唤醒。外设包括 LIN、CAN、GPIO、PWM。
- **Cohort 4 · 中央网关与通信（ASIL B）**：占 RTU 2 的 Cluster 1（2 核 Split）+ RCU 独立通信核，5 MB SRAM。RCU 是内置专用 R52 的硬件通信卸载单元，负责 CAN/LIN/FlexRay 报文的底层收发和过滤，不占用业务核；业务 R52 只跑高层路由策略、IDPS、DoIP 诊断网关、SOME/IP 基础服务。外设包括 NETC4 TSN 以太网交换机、CAN Hub、LIN/FlexRay。

设计要点：

**动力和底盘各占一个完整 RTU。** 这两个域都是 ASIL D，独占 RTU 意味着真正的硬件级故障隔离——动力域的时钟或电源故障不会波及底盘域，反之亦然。如果塞进同一个 RTU 靠 Hypervisor 隔离，共享的时钟和电源域会成为故障传播通道，功能安全认证时很难论证 FFI（无干扰）。

**ADAS 安全监控放在底盘 Cohort 内部。** 它是舱驾 SoC 智驾输出和执行器之间的安全闸门——舱驾 SoC 规划出目标车速、转角、扭矩，经 TSN 进入共享内存，安全监控做合理性校验（加速度是否超物理极限？转角是否和车速匹配？），通过才转发给底盘执行，不通过则触发 MRM。和底盘控制同属一个 Cohort，通信走片内共享内存，延迟最低，且共享 ASIL D 认证边界。

**车身和网关共享 RTU 2。** 两者都是 ASIL B，安全等级同档，都不需要锁步。共享 RTU 的代价是时钟/电源故障会同时影响两者，但 ASIL B 的故障处理策略可以覆盖这个风险——相比独占 RTU 浪费的 4 核资源，这是可接受的折中。

#### 应用服务域：Cohort 5 ~ 6（Cortex-A78AE）

8 颗 A78AE 分成四个 Cluster（每 Cluster 2 核），LPDDR5X DRAM 分配给 A 核使用。两个 Cohort 各占 2 个 Cluster（4 核），裸机运行 Yocto 定制 Linux。

![应用服务域 · Cohort 5 ~ 6（Cortex-A78AE · Linux）](/assets/img/deployment-design/s32n7-cohort-a78-application.svg)

- **Cohort 5 · 整车服务与数据平台（QM / ASIL B）**：4 核 A78AE + LPDDR5X DRAM + 高速外设（UFS、PCIe、以太网、USB）。跑全局 OTA 编排、车辆数据中台与上云对接、远程诊断与日志分析、SOA 服务编排（SOME/IP 注册与路由）、TSP 车云中间件。
- **Cohort 6 · 智能应用与边缘计算（QM）**：4 核 A78AE + eIQ Neutron NPU + LPDDR5X DRAM。跑预测性维护（电池 SOH、底盘磨损）、边缘 AI 推理（驾驶行为分析、能耗优化）、ADAS 结果后处理与安全校验、整车安全审计与入侵溯源、数据闭环与影子模式。

设计要点：

**拆成两个独立 Cohort 而不是一个。** OTA 和数据中台是整车基础服务，必须高可用；边缘 AI 是增值业务，崩溃不应该影响基础服务。两个 Cohort 之间靠 XRDC 硬件隔离，比同一个 Cohort 内靠 Hypervisor 软件隔离更可靠。

**A 核默认全 Split 模式。** 这里没有微秒级闭环，锁步只会白砍一半算力。如果将来某个服务需要安全等级，可以在 PaCo 中把对应 Cluster 切到 Lock 模式，硬件能力在，按需启用。

#### Cohort 资源与功能分配总表

把七个 Cohort 放在一张表里汇总：

| Cohort | 硬件归属 | 核模式 | 内存 | 功能覆盖 | 安全等级 | OS / 部署 |
|--------|---------|--------|------|---------|---------|----------|
| Cohort 0：SBC 系统基础组 | FSS 子系统（2×锁步 CM7）+ 系统外设 | 锁步 | 3 MB SRAM | PaCo 解析、XRDC 配置、安全启动、Cohort 生命周期、全局故障管理、HSE 权限策略 | ASIL D | NXP 专用 RTOS · 单 UENV · 无 Hypervisor |
| Cohort 1：动力总成 | 完整 RTU 0（4×R52）+ 动力外设 | 全 Lock | 10 MB SRAM | 电机控制、BMS、OBC、DC-DC、动力域诊断 | ASIL D | AUTOSAR Classic · 单 UENV · 裸机 |
| Cohort 2：底盘与运动控制 | 完整 RTU 1（4×R52）+ 底盘外设 | 全 Lock | 10 MB SRAM | 底盘控制（EPS/ESC/制动/悬架/VDC）+ ADAS 安全监控（意图校验、MRM） | ASIL D | AUTOSAR Classic · 单 UENV · 裸机 |
| Cohort 3：车身与舒适 | RTU 2 · Cluster 0（2×R52）+ 车身外设 | Split | 5 MB SRAM | BCM、灯光/门窗/座椅、热管理、泊车辅助、休眠唤醒 | ASIL B | AUTOSAR Classic · 单 UENV · 裸机 |
| Cohort 4：中央网关与通信 | RTU 2 · Cluster 1（2×R52）+ RCU 独立 R52 + 通信外设 | Split | 5 MB SRAM | 路由策略、TSN 配置、IDPS、DoIP 诊断、SOME/IP 基础服务 | ASIL B | AUTOSAR Classic · 双 UENV（RCU 卸载 + 业务策略）· 裸机 |
| Cohort 5：整车服务与数据平台 | APS · 2 Cluster（4×A78AE）+ 高速外设 | Split | LPDDR5X DRAM | OTA 编排、数据中台、远程诊断、SOA 服务编排、TSP 中间件 | QM / ASIL B | Yocto Linux · 单 UENV · 裸机 |
| Cohort 6：智能应用与边缘计算 | APS · 2 Cluster（4×A78AE）+ eIQ Neutron NPU | Split | LPDDR5X DRAM | 预测性维护、边缘 AI 推理、ADAS 后处理、安全审计、数据闭环 | QM | Yocto Linux · 单 UENV · 裸机 |

资源核算：R52 业务核 4+4+2+2 = 12 核，刚好用满全部通用 R52（RCU 为独立硬件核，不占用配额）；A78 4+4 = 8 核，占满全部应用核。R 核使用片上 SRAM，A 核使用 LPDDR5X DRAM，内存资源按核群属性自然分流。

### 4.3 关键设计考量

#### 什么时候才需要 Hypervisor

上面的方案里，A 侧和 R 侧都没有使用 Hypervisor。这不是否定 Hypervisor 的价值，而是在当前硬件资源充足、单 Owner 全自研的前提下，裸机方案更简单可靠。Hypervisor 有它明确的适用场景：

**场景一：内核资源不够用，需要一筐硬件跑多个 OS。** 比如某个 Cohort 只有 2 核，但需要同时跑两套独立的 AUTOSAR 实例（第三方软件不想合并），这时候在该 Cohort 内引入 EL2-Monitor（R52 侧的轻量监控器，L4Re<sup>[14](#ref-14)</sup>、ZVM<sup>[15](#ref-15)</sup> 这类方案都属此类）或 A-profile Hypervisor（Vector 的 MICROSAR Hypervisor 即定位于此<sup>[16](#ref-16)</sup>），把 2 核虚拟成多个 Guest。资源充足时不需要走这一步。

**场景二：需要 Guest 级故障隔离，且不接受 Cohort 级的硬件开销。** Cohort 是硬件隔离边界，创建和销毁都要改 PaCo、重启芯片；Hypervisor 的 Guest 可以在运行时单独复位，灵活性更高。如果某个域内部有多个功能需要独立复位、但又不值得各占一个 Cohort，Hypervisor 是合适的工具。

**场景三：软件资产复用，老镜像不想改。** 原有 ECU 的 AUTOSAR 镜像不作大修改，直接作为 Guest 跑在 Hypervisor 之上，减少移植工作量。

**场景四：A 侧需要同时运行 Linux 和 QNX。** 比如整车服务用 Linux，安全相关的 OTA 校验用 QNX for Safety，两者在同一个 Cohort 内用 Hypervisor 隔离。

反过来说，以下情况不建议用 Hypervisor：ASIL D 最高安全等级（Hypervisor 本身要做完整认证，增加巨大工作量）、Multi-Owner 多供应商场景（必须靠 Cohort 硬件隔离，Hypervisor 软件隔离不够）、极致低延迟硬实时（虚拟化引入调度抖动）。

一句话总结：**Hypervisor 是 Cohort 内部的补充工具，不是 Cohort 的替代品。Cohort 解决硬件级的域间隔离，Hypervisor 解决同一个域内部的软件级细分。资源够、单 Owner、功能边界清晰时，裸机多 Cohort 是更简洁的选择。**

#### 核间通信：36 MB SRAM 是关键

A 核和 R 核之间、R 核各 Cohort 之间的数据交换，是 S32N7 能否扛起车辆核心的关键。S32N79 有 36 MB 片上 SRAM，这是核间通信的核心资产。典型的设计是：

- **共享内存区**：在 SRAM 中划出共享区域，用硬件信号量做同步。舱驾 SoC 送来的智驾控制意图落在共享区，R 核 ADAS 安全监控（底盘 Cohort 内）读走做校验；R 核写车辆状态，A 核读走供服务层组装和状态上报。
- **Cohort 内通信**：同一 Cohort 内的功能模块（如底盘控制和 ADAS 安全监控）通过共享内存通道通信，延迟亚微秒级。
- **跨 Cohort 通信**：不同 Cohort 之间通过片内 SRAM 的共享区通信，走片内互联总线，延迟微秒级。
- **SMMU 地址转换**：A 核侧的 Linux 用虚拟地址，R 核侧的 RTOS 用物理地址，SMMU 负责 DMA 地址转换和访问权限控制。
- **Central DMA**：大块数据搬运交给 Central DMA 引擎，不占用 A 核和 R 核。

和跨芯片方案（毫秒级）比，片内共享 SRAM 的延迟是**微秒级甚至亚微秒级**，差了三个数量级。这些机制在商用芯片上都有现成的核间通信框架支撑（共享内存 + mailbox + 中断通知是通用范式），不用自己造轮子；设计时真正要花心思的是共享区怎么划分、访问权限怎么控。

#### 硬件隔离体系

把这么多功能域放进一颗芯片，光靠 Hypervisor 的软件隔离不够，必须有总线级的硬件隔离。S32N79 的 XRDC（eXtended Resource Domain Controller）就是干这个的——给每个 Cohort 分配 Domain ID，在总线层面决定它能不能访问某块内存、某个外设。

结合上面的部署方案，隔离的原则可以概括成三句话：**每个域只能访问自己必需的资源**——底盘域拿底盘外设和专属 SRAM 区，网关域拿网络引擎，应用域拿 DDR 和 NPU，彼此的控制寄存器互不可见；**跨域数据只走共享通信区**，用硬件信号量同步；**中断按域路由**——外设中断只送到所属域的核，底盘的中断不会被车身的核响应。至于每域分多少 SRAM、外设具体映射到哪个域，是项目级的设计工作，要按算法内存需求和功能安全分解逐项定义，这里不展开。

这套资源域机制还有一层更工程化的用法：**把每个资源域当作一个虚拟 ECU（vECU）来经营**。官方的隔离架构正是这样定义的——一个资源域是硬件强制边界下的一组资源集合（可以 A 核、R 核混合编组），有自己的 owner，能被独立复位、独立下电，域与域之间互不干扰、默认不协作；资源怎么分写成分区契约（PaCo），启动时由系统管理域强制执行。多供应商场景下这个模型尤其有价值：各供应商"互不信任"，分区契约需要各方签名，改一个字节都过不了安全启动。于是整车厂可以把不同供应商的软件作为独立的资源域整合进同一颗芯片，任何一方的升级、复位、失效都不波及别人——这是"ECU 整合"在隔离层面的完整答案（NXP 把这套模型称为 Cohort/UENV，名词不同，模型是通用的<sup>[9](#ref-9)</sup>）。

故障反应同样是分级的：域内软件先本地处理；处理不了，升级为域安全状态——该域复位、给出安全输出；再不行，由系统管理域收权，进入 SoC 级安全状态。安全上下文由管家核先建立（上电即 boot to safety），再逐域扩张到各个资源域。对应到本方案：底盘 Cohort 的故障在本域内消化，某个 Cohort 异常只影响本域，只有波及共享资源的故障才升级为整片安全状态。

除了 XRDC，还有两层安全机制：

- **Split/Lock**：安全相关的核用 Lock 模式做故障检测（RTU 0 和 RTU 1 全部锁步，对应动力和底盘域），非安全相关的核用 Split 模式——两种模式的硬件机制与适用边界见 Arm 的 R52 技术资料<sup>[17](#ref-17)</sup><sup>[18](#ref-18)</sup>。
- **HSE2（Hardware Security Engine 2）**：独立的硬件安全引擎，负责密钥存储、加解密、安全启动、生命周期管理。主核无法直接访问其内部状态。

三层叠加：**XRDC 做 Cohort 间硬件隔离 → 按需引入 Hypervisor 做 Cohort 内软件隔离 → Split/Lock 做核内故障检测**，密钥和安全启动由独立的 HSE2 保护。在隔离强度上，这种多层叠加方案可以达到物理分离的水平，而跨域通信延迟反而比多芯片方案低几个数量级——这是控制域集中到一颗芯片上的核心优势。

### 4.4 对外通信与平台协同

中央控制器的通信接口由 Cohort 4（网关）统一管理：NETC4 TSN 以太网交换机负责骨干网互联（7 个外部端口，支持 10 Gbps 到 10 Mbps，带 MACsec 链路加密），RCU 独立通信核负责 CAN/LIN/FlexRay 的底层报文卸载，业务 R52 只处理高层路由策略。具体的资源归属已在 4.2 节的 Cohort 4 中说明，这里重点看车辆核心与舱驾 SoC、区域控制器之间的协同。

中央计算平台内部，S32N7 与舱驾一体 SoC 之间有三条典型数据流：

1. **智驾控制闭环**：舱驾 SoC 的智驾输出控制意图（目标车速、转角、扭矩）→ TSN 骨干网 → S32N7 共享内存 → ADAS 安全监控（底盘 Cohort 内）校验 → 底盘/动力 Cohort 执行。整条链路的安全闸门在 S32N7 上——舱驾 SoC 无论怎么失控，执行器前面都有一道 ASIL D 的检查。
2. **车辆状态上行**：R 核各域汇总的车辆状态（车速、挡位、电源模式）进共享区，舱驾 SoC 取用做智驾规划约束和座舱显示；SOA 服务把状态包装成标准服务接口，舱驾侧像调用本地服务一样取整车数据。
3. **车控服务下行**：座舱应用要开车窗、调空调，请求经服务网关（A 核车辆管理域）路由到对应域执行——座舱永远碰不到执行器，它拿到的只是服务。

互联层面，TSN 以太网骨干承担绝大部分流量，TSN 的确定性调度保证控制意图的传输延迟有界——这是以太网敢进控制闭环的前提。PCIe Gen4 用于两颗主芯片间的大带宽点对点（传感器数据直通，或者将来外挂 AI 加速）。

再往外一层是区域控制器：ZCU 挂在骨干网上，就近驱动执行器、采集传感器、做智能配电。中央计算负责决策，ZCU 负责确定性地执行；即使中央计算整体失效，ZCU 也能维持基础安全功能——这是"集中决策、分布执行"的标准形态。整车级 OTA 的汇聚点在中央计算平台，数据闭环的采集源头是全车，车云协同的出口也在平台的服务域里。

这样的平台里有一处容易被低估的收益：**S32N7 的"长期稳定"和舱驾 SoC 的"快速换代"被解耦了**。车辆核心一套软件平台稳定演进十年，座舱智驾按消费电子节奏三四年换一代芯片——这正是把智能手机域挡在硬安全边界之外的真正动机。

## 5 总结——中央集成本质是软件核心策略上移

把三个阶段串起来看：

| 阶段 | 部署形态 | 应用层 | 实时层 | 隔离方式 | 跨域延迟 |
|------|---------|--------|--------|---------|---------|
| 独立域控 | 座舱域 SoC + MCU；智驾域 AI SoC | 域内 Rich OS（Android/Linux） | 域内 MCU 与安全岛跑 RTOS/CP | 物理分离 | 毫秒级（以太网/CAN） |
| 舱驾一体控制器 | SoC Hypervisor + 外置 MCU | SoC 多 Guest 虚拟化 | 外置 MCU 跑 AUTOSAR CP | 虚拟化 + 物理分离 | 毫秒级（以太网/CAN） |
| 中央计算平台 | 舱驾一体 SoC + 车辆核心（S32N7）协同 | 舱驾 SoC 多 Guest 虚拟化；S32N7 的 A 核分两个 Cohort 跑车辆服务与边缘计算 | R 核按功能域划分 Cohort，ASIL D 独占 RTU，裸机 AUTOSAR | XRDC 硬件隔离（Cohort 级）+ 锁步 + 按需 Hypervisor | 片内亚微秒级，骨干有界延迟 |

演进的方向很清晰：**芯片数量在减少，单芯片内的隔离层次在增加，跨域通信延迟在下降**。而且这条上移是分两步走的：应用侧先融合（阶段二的舱驾一体），实时侧再跟上（阶段三的车辆核心）——大脑和小脑各自完成自己的集中化，最后在中央计算平台会师。

我个人觉得这个趋势可以用一个类比来理解：芯片行业从独立显存走向统一内存架构（UMA）——CPU 和 GPU 共享同一块内存，减少数据拷贝、降低延迟、提升效率，NVIDIA RTX 系列和 Apple M 系列都是这个思路。汽车的中央计算也是类似的逻辑：原来分散在各个 ECU 里的软件功能，被"统一"到一颗芯片的不同核群里，通过片内高速互联和共享内存交换数据。**UMA 是芯片层面的集成，中央计算是软件功能层面的集成**，底层驱动力是一样的——减少数据搬运的距离和开销。

回到 S32N79 的部署方案，有几个设计决策是我个人的判断，不一定是唯一正确答案：

1. **按功能域划分 Cohort，ASIL D 域独占完整 RTU**——动力、底盘各占一个 RTU，车身和网关共享第三个 RTU。Cohort 是 XRDC 硬件强制隔离的边界，比 Hypervisor 软件隔离更可靠。
2. **ADAS 安全监控放在底盘 Cohort 内部**——和底盘控制共享一对锁步核，是舱驾 SoC 智驾和执行器之间的安全闸门，没有它，非安全的智驾 OS 就不能直接控制车辆。
3. **A 核拆成两个独立 Cohort**——整车服务与数据平台、智能应用与边缘计算，靠硬件隔离保证基础服务不被增值业务拖垮。
4. **默认裸机运行，不使用 Hypervisor**——资源充足、单 Owner 全自研时，裸机多 Cohort 更简单、认证成本更低、实时性更确定；Hypervisor 只在资源紧张或需要 Guest 级灵活隔离时引入。
5. **A 核定位为车辆服务与协同平台，座舱和智驾留给舱驾一体 SoC**——用无 GPU/ISP、TOPS 级 NPU 和生态绑定三条硬理由，把 A 核从"什么都要"拉回"服务与协同"，换来的是干净的职责边界和两颗芯片各自独立的换代节奏。

这些决策的底层逻辑是一致的：**在中央计算芯片上，隔离性和确定性不是靠 Hypervisor 一层软件保证的，而是靠"XRDC 硬件隔离（Cohort 级）+ RTU 级故障域 + 锁步故障检测"多层叠加保证的**。Hypervisor 是 Cohort 内部的补充工具，不是隔离的主力——让多个功能域在同一颗芯片上各自独立、互不干扰，首先靠的是硬件边界。

对汽车来说，中央集成的收益是具体的：ECU 数量减少、线束缩短、BOM 成本下降、跨域数据延迟降低、OTA 更集中。对机器人来说，这个趋势更紧迫——人形机器人的体积和重量约束比汽车严得多，几十关节的实时控制 + 视觉感知 + 大模型推理，如果还靠"x86 主控 + 嵌入式控制器"的双芯片方案，功耗和体积都压不下来。RK3588 这类方案已经在简单机器人上验证了"单芯片大脑 + 小脑"的可行性，S32N79 这类车规级超级集成芯片则是在汽车级的性能和安全要求下实践这个思路。

S32N79 不会是孤例。可以预判各家芯片厂商都会推出类似的"超级集成"芯片，竞争点在三处：**核群配比**（A/R/NPU 怎么搭）、**安全隔离能力**（XRDC 这类硬件隔离 + ASIL D 认证路线）、**软件生态**（Hypervisor、AUTOSAR、中间件的成熟度<sup>[19](#ref-19)</sup><sup>[20](#ref-20)</sup>）。

部署设计的演进还没到终点。但方向已经很明确了：**从多芯片物理分离，走向片内的软硬协同隔离**。

最后回到写这一篇的初衷：S32N7 只是样本，这篇文章真正想沉淀的是一套部署设计的判断框架——先定位芯片在算力版图中的角色，再按"实时 vs 应用"切分核群，按功能域和安全等级划分隔离域，用 Cohort 硬件隔离和锁步核锁死确定性，用硬件资源域而不是纯软件保证隔离。换成任何一颗超级集成芯片，这套框架都成立。


## 参考文献

<ol>
<li id="ref-1"><a href="https://www.eetimes.com/inside-teslas-model-3/">Inside Tesla's Model 3 — EE Times</a></li>
<li id="ref-2"><a href="https://zhuanlan.zhihu.com/p/711605829">Tesla Model 3（2019）E/E 架构图 — 知乎</a></li>
<li id="ref-3"><a href="https://zhinengzuocang.cn/post/cockpit-driving-fusion">舱驾一体方案与架构设计 — 智能座舱网</a></li>
<li id="ref-4"><a href="https://community.arm.com/arm-community-blogs/b/automotive-blog/posts/automotive-virtualization-embedded-hypervisor">Automotive real-time virtualization — ARM Community</a></li>
<li id="ref-5"><a href="https://www.ghs.com/news/20240403_NXP_S32_CoreRide_platform_SDV.html">GHS for NXP S32 CoreRide Platform — Green Hills Software</a></li>
<li id="ref-6"><a href="https://mp.weixin.qq.com/s/kNPLf0ytFkxY1Ze6t-TknQ">RK3588 Linux + RTOS 双系统（AMP）方案 — 微信公众号</a></li>
<li id="ref-7"><a href="https://mp.weixin.qq.com/s/pbgw5My5nvaGdYru8ynPyg">一芯多 OS 自平衡小车案例 — 微信公众号</a></li>
<li id="ref-8">NXP Technology Days 2025 技术资料：S32N55 Vehicle Super-Integration Processor — Enabling Centralized Real-Time Control for SDVs（TP-TD-DETROIT-S32N55-VEH-SI-INT，未公开链接）</li>
<li id="ref-9">NXP Technology Days 2025 技术资料：Enabling Multi-Owner Scenarios — S32N Isolation Architecture for Advanced ECU Consolidation in SDVs（TP-TD-DETROIT-ENB-MUL-OWN-SCE，未公开链接）</li>
<li id="ref-10"><a href="https://www.nxp.com.cn/products/S32N7">S32N7 官方产品页 — NXP</a></li>
<li id="ref-11"><a href="https://www.nxp.com.cn/products/processors-and-microcontrollers/s32-automotive-platform/s32n-vehicle-super-integration-processors:S32N">S32N Vehicle Super-Integration Processors 系列介绍 — NXP</a></li>
<li id="ref-12"><a href="https://zhuanlan.zhihu.com/p/2029483336758740731">NXP 新一代中央计算架构 S32N7 平台解析 — 知乎</a></li>
<li id="ref-13"><a href="https://investors.nxp.com/news-releases/news-release-details/nxps-new-s32n7-unlocks-full-potential-sdvs">NXP's New S32N7 Unlocks the Full Potential of SDVs — NXP Newsroom</a></li>
<li id="ref-14"><a href="https://www.l4re.org/bsp/s32n79.html">L4Re on S32N79 BSP — Kernkonzept</a></li>
<li id="ref-15"><a href="https://esnl.hnu.edu.cn/zvm/about-zvm.html">ZVM 介绍 — 湖南大学 ESNL</a></li>
<li id="ref-16"><a href="https://www.vector.com/zh/product/microsar-hypervisor/">MICROSAR Hypervisor 产品页 — Vector</a></li>
<li id="ref-17"><a href="https://aijishu.com/a/1060000000399237">ARM Cortex-R52 软件集成最佳实践 — 极术社区</a></li>
<li id="ref-18"><a href="https://www.arm.com/products/silicon-ip-cpu/cortex-r/cortex-r52">Cortex-R52 产品页 — Arm</a></li>
<li id="ref-19"><a href="https://www.globalautoinsight.com/news/etas-rta-car-autosar-nxp-s32n7-sdv-platform">RTA-CAR AUTOSAR for S32N7 SDV Platform — ETAS</a></li>
<li id="ref-20"><a href="https://lwn.net/Articles/1061849/">Linux upstream S32N79 support — LWN</a></li>
</ol>
