fn main() {
    tauri_build::build();

    // ---------------------------------------------------------- 要求管理员权限
    //
    // ★ 为什么必须要求管理员权限
    //
    //   easytier-core 通过 wintun 驱动创建虚拟网卡（TUN），需要加载内核驱动、
    //   修改网络配置。普通用户令牌下必然失败：
    //
    //     实测（runas /trustlevel:0x20000 降权启动 core）：
    //       ERROR CORE::INSTANCE: tun device error err=rust tun error Failed to create adapter
    //       ERROR CORE: error=some instances stopped with errors
    //       → 进程直接退出
    //
    //     同一 exe、同一配置，管理员令牌下：
    //       INFO CORE::INSTANCE: tun device ready dev="et_6_xxxx"      ← 正常
    //
    // ★ 实现方式：只用 /MANIFESTUAC
    //
    //   Tauri 的 resource.lib 里已经带了一个 manifest 资源
    //   （MANIFEST/1/0x0409，含 DPI 和兼容性声明）。
    //
    //   踩过的坑：
    //     /MANIFESTINPUT:app.manifest  → CVT1100 duplicate resource（两个 manifest 打架）
    //     /MANIFEST:EMBED              → 同样 CVT1100
    //
    //   正确做法：只加 /MANIFESTUAC。它不引入新资源，
    //   而是让链接器改写它自己生成的那份 manifest 的
    //   requestedExecutionLevel 节点，因此不会冲突。
    #[cfg(target_os = "windows")]
    embed_manifest_uac();
}

#[cfg(target_os = "windows")]
fn embed_manifest_uac() {
    // level='requireAdministrator' → 双击时弹 UAC，提权运行
    // uiAccess='false'             → 普通桌面应用
    println!("cargo:rustc-link-arg=/MANIFESTUAC:level='requireAdministrator' uiAccess='false'");
}
